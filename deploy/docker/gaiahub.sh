#!/bin/bash
# Enable exit on error
set -eo pipefail

TASK="$1"
SCRIPTPATH=$(pwd -P)
FILE_BASE="docker-compose-base.yaml"
FILE_DISK="docker-compose-disk.yaml"
FILE_ENV="disk.env"

# # Base colors
COLRED=$'\033[31m' # Red
COLGREEN=$'\033[32m' # Green
COLYELLOW=$'\033[33m' # Yellow
COLBLUE=$'\033[34m' # Blue
COLMAGENTA=$'\033[35m' # Magenta
COLCYAN=$'\033[36m' # Cyan

# # Bright colors
COLBRRED=$'\033[91m' # Bright Red

# # Text formatting
COLBOLD=$'\033[1m' # Bold Text

# # Text rest to default
COLRESET=$'\033[0m' # reset color

#Prints instructions to show possible commands
instructions() {
	echo
	echo "Usage:"
	echo " To start the GAIA Hub type: ${COLCYAN}$0 start ${COLRESET}"
	echo " To stop the GAIA Hub type: ${COLCYAN}$0 stop${COLRESET}"
	echo " To check if GAIA Hub is running type: ${COLCYAN}$0 status${COLRESET}"
	echo " Simply typing ${COLCYAN}$0${COLRESET} displays this help message."
	echo
	exit 0
}

#Checks files I need exist
check_files_exist() {
	# If a file I need is missing, inform the user.
	if ! [ -f "$FILE_BASE" ]; then
		echo "${COLRED}Error: Missing $FILE_BASE{COLRESET}. Did you delete it?" >&2
		return 1
	fi
	if ! [ -f "$FILE_DISK" ]; then
		echo "${COLRED}Error: Missing $FILE_DISK{COLRESET}. Did you delete it?" >&2
		return 1
	fi
	if ! [ -f "$FILE_ENV" ]; then
		echo "${COLRED}Error: Missing $FILE_ENV${COLRESET}. Looks like you forgot to create one." >&2
		return 1
	fi
	# If all files I need exist, then continue
	return 0
}

#Checks if already running my containers
check_containers() {
	if [[ $(docker compose -f "${SCRIPTPATH}"/"${FILE_BASE}" -f "${SCRIPTPATH}"/"${FILE_DISK}" --env-file "${SCRIPTPATH}"/"${FILE_ENV}" ps -q) ]];
	then
		# docker running
		return 0
	fi
	# docker not running
	return 1
}

gh_status() {
	if check_containers; then
		echo "GAIA HUB is running."
		return 1
	fi
	echo "GAIA HUB is not running."
	return 0
}

#Starts GAIA HUB
gh_start() {
	if check_containers; then
		echo "GAIA Hub already running. I won't do anything."
		return 1
	fi
	docker compose -f "${SCRIPTPATH}"/"${FILE_BASE}" -f "${SCRIPTPATH}"/"${FILE_DISK}" --env-file "${SCRIPTPATH}"/"${FILE_ENV}" up -d
	echo "GAIA HUB started."
	return 0
}

#Stops GAIA HUB
gh_stop() {
	if ! check_containers; then
		echo "GAIA Hub is not running, so there is nothing to stop."
		return 1
	fi
	docker compose -f "${SCRIPTPATH}"/"${FILE_BASE}" -f "${SCRIPTPATH}"/"${FILE_DISK}" --env-file "${SCRIPTPATH}"/"${FILE_ENV}" down
	echo "GAIA HUB stopped."
	return 0
}

#Exit on error if the programs I need are not found
exit_error() {
   printf "%s" "$1" >&2
   exit 1
}

for cmd in grep docker; do
   command -v "$cmd" >/dev/null 2>&1 || exit_error "Missing command: $cmd"
done

#Starts GH, Stops GH or displays instructions.
#Will only execute the start, stop and status if the files I need exist. If they don't it will display a warning.
case ${TASK} in 
	start|up)
		if check_files_exist; then
			echo "will start"
			gh_start
		fi
		;;
	stop|down)
		if check_files_exist; then
			gh_stop
		fi
		;;
	status)
		if check_files_exist; then
			gh_status
		fi
		;;
	*)
		instructions
		;;
esac
