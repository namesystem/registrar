

import { validateAuthorizationHeader, getAuthenticationScopes, AuthScopeValues } from './authentication'
import { ValidationError, DoesNotExist, PayloadTooLargeError } from './errors'
import { ProofChecker } from './ProofChecker'
import { AuthTimestampCache } from './revocations'

import { Readable } from 'stream'
import { DriverModel, PerformWriteArgs, PerformRenameArgs, PerformDeleteArgs, PerformListFilesArgs, ListFilesStatResult, ListFilesResult } from './driverModel'
import { HubConfigInterface } from './config'
import { logger, generateUniqueID, bytesToMegabytes, megabytesToBytes, monitorStreamProgress } from './utils'

export class HubServer {
  driver: DriverModel
  proofChecker: ProofChecker
  whitelist?: Array<string>
  serverName: string
  readURL?: string
  requireCorrectHubUrl: boolean
  validHubUrls?: Array<string>
  authTimestampCache: AuthTimestampCache
  config: HubConfigInterface
  maxFileUploadSizeMB: number
  maxFileUploadSizeBytes: number

  constructor(driver: DriverModel, proofChecker: ProofChecker, config: HubConfigInterface) {
    this.driver = driver
    this.proofChecker = proofChecker
    this.config = config
    this.whitelist = config.whitelist
    this.serverName = config.serverName
    this.validHubUrls = config.validHubUrls
    this.readURL = config.readURL
    this.requireCorrectHubUrl = config.requireCorrectHubUrl || false
    this.authTimestampCache = new AuthTimestampCache(this.getReadURLPrefix(), driver, config.authTimestampCacheSize)
    this.maxFileUploadSizeMB = (config.maxFileUploadSize || 20)
    // megabytes to bytes
    this.maxFileUploadSizeBytes = megabytesToBytes(this.maxFileUploadSizeMB)
  }

  async handleAuthBump(address: string, oldestValidTimestamp: number, requestHeaders: { authorization?: string }) {
    await this.validate(address, requestHeaders)
    await this.authTimestampCache.setAuthTimestamp(address, oldestValidTimestamp)
  }

  // throws exception on validation error
  //   otherwise returns void.
  async validate(address: string, requestHeaders: { authorization?: string }, oldestValidTokenTimestamp?: number) {
    const signingAddress = await validateAuthorizationHeader(
      requestHeaders.authorization,
      this.serverName, address,
      this.requireCorrectHubUrl,
      this.validHubUrls, 
      oldestValidTokenTimestamp)

    if (this.whitelist && !(this.whitelist.includes(signingAddress))) {
      throw new ValidationError(`Address ${signingAddress} not authorized for writes`)
    }
  }

  async handleListFiles(address: string,
                        page: string | undefined,
                        stat: boolean,
                        requestHeaders: { authorization?: string }) {
    const oldestValidTokenTimestamp = await this.authTimestampCache.getAuthTimestamp(address)
    const scopes = getAuthenticationScopes(requestHeaders.authorization)
    const isArchivalRestricted = this.isArchivalRestricted(scopes)

    await this.validate(address, requestHeaders, oldestValidTokenTimestamp)

    const listFilesArgs: PerformListFilesArgs = {
      pathPrefix: address,
      page: page
    }

    let listFileResult: ListFilesResult | ListFilesStatResult
    if (stat) {
      listFileResult = await this.driver.listFilesStat(listFilesArgs)
    } else {
      listFileResult = await this.driver.listFiles(listFilesArgs)
    }

    // Filter historical files from results.
    if (isArchivalRestricted && listFileResult.entries.length > 0) {
      if (stat) {
        listFileResult.entries = (listFileResult as ListFilesStatResult).entries
          .filter(entry => !this.isHistoricalFile(entry.name))
      } else {
        listFileResult.entries = (listFileResult as ListFilesResult).entries
          .filter(entry => !this.isHistoricalFile(entry))
      }

      // Detect empty page due to all files being historical files.
      if (listFileResult.entries.length === 0 && listFileResult.page) {
        // Insert a null marker entry to indicate that there are more results
        // even though the entry array is empty.
        listFileResult.entries.push(null)
      }
    }

    return listFileResult
  }

  getReadURLPrefix() {
    if (this.readURL) {
      return this.readURL
    } else {
      return this.driver.getReadURLPrefix()
    }
  }

  getFileName(filePath: string) {
    const pathParts = filePath.split('/')
    const fileName = pathParts[pathParts.length - 1]
    return fileName
  }

  getHistoricalFileName(filePath: string) {
    const fileName = this.getFileName(filePath)
    const filePathPrefix = filePath.slice(0, filePath.length - fileName.length)
    const historicalName = `.history.${Date.now()}.${generateUniqueID()}.${fileName}`
    const historicalPath = `${filePathPrefix}${historicalName}`
    return historicalPath
  }
  
  isHistoricalFile(filePath: string) {
    const fileName = this.getFileName(filePath)
    const isHistoricalFile = fileName.startsWith('.history.')
    return isHistoricalFile
  }

  async handleDelete(
    address: string, path: string,
    requestHeaders: { authorization?: string }
  ) {
    const oldestValidTokenTimestamp = await this.authTimestampCache.getAuthTimestamp(address)
    await this.validate(address, requestHeaders, oldestValidTokenTimestamp)

    // can the caller delete? if so, in what paths?
    const scopes = getAuthenticationScopes(requestHeaders.authorization)
    const isArchivalRestricted = this.checkArchivalRestrictions(address, path, scopes)

    if (scopes.deletePrefixes.length > 0 || scopes.deletePaths.length > 0) {
      // we're limited to a set of prefixes and paths.
      // does the given path match any prefixes?
      let match = !!scopes.deletePrefixes.find((p) => (path.startsWith(p)))

      if (!match) {
        // check for exact paths
        match = !!scopes.deletePaths.find((p) => (path === p))
      }

      if (!match) {
        // not authorized to write to this path
        throw new ValidationError(`Address ${address} not authorized to delete from ${path} by scopes`)
      }
    }

    await this.proofChecker.checkProofs(address, path, this.getReadURLPrefix())

    if (isArchivalRestricted){
      // if archival restricted then just rename the canonical file to the historical file
      const historicalPath = this.getHistoricalFileName(path)
      const renameCommand: PerformRenameArgs = {
        path: path,
        storageTopLevel: address,
        newPath: historicalPath
      }
      await this.driver.performRename(renameCommand)
    } else {
      const deleteCommand: PerformDeleteArgs = {
        storageTopLevel: address,
        path
      }
      await this.driver.performDelete(deleteCommand)
    }
  }

  async handleRequest(
    address: string, path: string,
    requestHeaders: {
      'content-type'?: string,
      'content-length'?: string | number,
      authorization?: string
    },
    stream: Readable
  ) {

    const oldestValidTokenTimestamp = await this.authTimestampCache.getAuthTimestamp(address)
    await this.validate(address, requestHeaders, oldestValidTokenTimestamp)
    let contentType = requestHeaders['content-type']

    if (contentType === null || contentType === undefined) {
      contentType = 'application/octet-stream'
    }

    // can the caller write? if so, in what paths?
    const scopes = getAuthenticationScopes(requestHeaders.authorization)
    const isArchivalRestricted = this.checkArchivalRestrictions(address, path, scopes)

    if (scopes.writePrefixes.length > 0 || scopes.writePaths.length > 0) {
      // we're limited to a set of prefixes and paths.
      // does the given path match any prefixes?
      let match = !!scopes.writePrefixes.find((p) => (path.startsWith(p)))

      if (!match) {
        // check for exact paths
        match = !!scopes.writePaths.find((p) => (path === p))
      }

      if (!match) {
        // not authorized to write to this path
        throw new ValidationError(`Address ${address} not authorized to write to ${path} by scopes`)
      }
    }

    await this.proofChecker.checkProofs(address, path, this.getReadURLPrefix())

    const contentLengthHeader = requestHeaders['content-length'] as string
    const contentLengthBytes = parseInt(contentLengthHeader)
    const isLengthFinite = Number.isFinite(contentLengthBytes) && contentLengthBytes > 0

    // If a valid content-length is specified check to immediately return error
    if (isLengthFinite && contentLengthBytes > this.maxFileUploadSizeBytes) {
      const errMsg = `Max file upload size is ${this.maxFileUploadSizeMB} megabytes. ` + 
        `Rejected Content-Length of ${bytesToMegabytes(contentLengthBytes, 4)} megabytes`
      logger.warn(`${errMsg}, address: ${address}`)
      throw new PayloadTooLargeError(errMsg)
    }

    if (isArchivalRestricted) {
      const historicalPath = this.getHistoricalFileName(path)
      try {
        await this.driver.performRename({
          path: path,
          storageTopLevel: address,
          newPath: historicalPath
        })
      } catch (error) {
        if (error instanceof DoesNotExist) {
          // ignore
          logger.debug(
            '404 on putFileArchival rename attempt -- usually this is okay and ' + 
            'only indicates that this is the first time the file was written: ' +
            `${address}/${path}`
          )
        } else {
          logger.error(`Error performing historical file rename: ${address}/${path}`)
          logger.error(error)
          throw error
        }
      }
    }

    // Use the client reported content-length if available, otheriwse fallback to the
    // max configured length.
    const maxContentLength = Number.isFinite(contentLengthBytes) && contentLengthBytes > 0 
      ? contentLengthBytes : this.maxFileUploadSizeBytes
    
    // Create a PassThrough stream to monitor streaming chunk sizes. 
    const { monitoredStream, pipelinePromise } = monitorStreamProgress(stream, totalBytes => {
      if (totalBytes > maxContentLength) {
        const errMsg = `Max file upload size is ${this.maxFileUploadSizeMB} megabytes. ` + 
          `Rejected POST body stream of ${bytesToMegabytes(totalBytes, 4)} megabytes`
        // Log error -- this situation is indicative of a malformed client request
        // where the reported Content-Size is less than the upload size. 
        logger.warn(`${errMsg}, address: ${address}`)

        // Destroy the request stream -- cancels reading from the client
        // and cancels uploading to the storage driver.
        const error = new PayloadTooLargeError(errMsg)
        stream.destroy(error)
        throw error
      }
    })

    const writeCommand: PerformWriteArgs = {
      storageTopLevel: address,
      path, stream: monitoredStream, contentType,
      contentLength: contentLengthBytes
    }
    const [readURL] = await Promise.all([this.driver.performWrite(writeCommand), pipelinePromise])
    const driverPrefix = this.driver.getReadURLPrefix()
    const readURLPrefix = this.getReadURLPrefix()
    if (readURLPrefix !== driverPrefix && readURL.startsWith(driverPrefix)) {
      const postFix = readURL.slice(driverPrefix.length)
      return `${readURLPrefix}${postFix}`
    }
    return readURL
  }
  
  isArchivalRestricted(scopes: AuthScopeValues) {
    return scopes.writeArchivalPaths.length > 0 || scopes.writeArchivalPrefixes.length > 0
  }

  checkArchivalRestrictions(address: string, path: string, scopes: AuthScopeValues) {
    const isArchivalRestricted = this.isArchivalRestricted(scopes)
    if (isArchivalRestricted) {
      // we're limited to a set of prefixes and paths.
      // does the given path match any prefixes?
      let match = !!scopes.writeArchivalPrefixes.find((p) => (path.startsWith(p)))

      if (!match) {
        // check for exact paths
        match = !!scopes.writeArchivalPaths.find((p) => (path === p))
      }

      if (!match) {
        // not authorized to write to this path
        throw new ValidationError(`Address ${address} not authorized to modify ${path} by scopes`)
      }
    }
    return isArchivalRestricted
  }

}
