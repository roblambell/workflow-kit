#!/bin/sh
set -eu

scenario_file="${NINTHWAVE_FAKE_AI_SCENARIO:-}"
item_id="${NINTHWAVE_LAUNCH_ITEM_ID:-unknown}"
agent_name="${NINTHWAVE_LAUNCH_AGENT:-worker}"
run_id="${NINTHWAVE_FAKE_AI_RUN_ID:-${item_id}-${agent_name}}"
state_dir="${NINTHWAVE_LAUNCH_STATE_DIR:?NINTHWAVE_LAUNCH_STATE_DIR is required}"
artifact_dir="${state_dir}/fake-ai-worker/${run_id}"
context_file="${artifact_dir}/context.env"
state_file="${artifact_dir}/state.env"
prompt_copy="${artifact_dir}/prompt.txt"
launches_file="${artifact_dir}/launches.log"
heartbeat_dir="${state_dir}/heartbeats"
heartbeat_file="${heartbeat_dir}/${item_id}.json"

mkdir -p "${artifact_dir}"
printf '%s|%s|%s\n' \
  "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
  "${NINTHWAVE_LAUNCH_AGENT:-}" \
  "${NINTHWAVE_LAUNCH_ITEM_ID:-}" >> "${launches_file}"

json_escape() {
  printf '%s' "${1}" | sed 's/\\/\\\\/g; s/"/\\"/g'
}

write_state() {
  status="$1"
  signal_name="${2:-}"
  {
    printf 'status=%s\n' "${status}"
    printf 'behavior=%s\n' "${behavior}"
    printf 'exitCode=%s\n' "${exit_code}"
    printf 'signal=%s\n' "${signal_name}"
  } > "${state_file}"
}

behavior="success"
exit_code="0"
heartbeat_progress=""
heartbeat_label=""
heartbeat_pr_number=""
sleep_ms="0"
sleep_before_heartbeat="1"

if [ -n "${scenario_file}" ] && [ -f "${scenario_file}" ]; then
  while IFS= read -r line || [ -n "${line}" ]; do
    case "${line}" in
      ""|\#*)
        ;;
      behavior=*)
        behavior="${line#behavior=}"
        ;;
      exitCode=*)
        exit_code="${line#exitCode=}"
        ;;
      sleepMs=*)
        sleep_ms="${line#sleepMs=}"
        ;;
      sleepBeforeHeartbeat=*)
        sleep_before_heartbeat="${line#sleepBeforeHeartbeat=}"
        ;;
      stdout=*)
        printf '%s\n' "${line#stdout=}"
        ;;
      stderr=*)
        printf '%s\n' "${line#stderr=}" >&2
        ;;
      heartbeat=*)
        payload="${line#heartbeat=}"
        heartbeat_progress="${payload%%|*}"
        rest="${payload#*|}"
        if [ "${rest}" = "${payload}" ]; then
          heartbeat_label=""
          heartbeat_pr_number=""
        else
          heartbeat_label="${rest%%|*}"
          if [ "${heartbeat_label}" = "${rest}" ]; then
            heartbeat_pr_number=""
          else
            heartbeat_pr_number="${rest#*|}"
          fi
        fi
        ;;
    esac
  done < "${scenario_file}"
fi

if [ -n "${NINTHWAVE_LAUNCH_PROMPT_FILE:-}" ] && [ -f "${NINTHWAVE_LAUNCH_PROMPT_FILE}" ]; then
  cp "${NINTHWAVE_LAUNCH_PROMPT_FILE}" "${prompt_copy}"
fi

{
  printf 'cwd=%s\n' "$(pwd)"
  printf 'tool=%s\n' "${NINTHWAVE_LAUNCH_TOOL:-}"
  printf 'mode=%s\n' "${NINTHWAVE_LAUNCH_MODE:-}"
  printf 'agent=%s\n' "${NINTHWAVE_LAUNCH_AGENT:-}"
  printf 'itemId=%s\n' "${NINTHWAVE_LAUNCH_ITEM_ID:-}"
  printf 'projectRoot=%s\n' "${NINTHWAVE_LAUNCH_PROJECT_ROOT:-}"
  printf 'workspaceName=%s\n' "${NINTHWAVE_LAUNCH_WORKSPACE_NAME:-}"
  printf 'promptFile=%s\n' "${NINTHWAVE_LAUNCH_PROMPT_FILE:-}"
  printf 'stateDir=%s\n' "${NINTHWAVE_LAUNCH_STATE_DIR:-}"
  printf 'scenarioFile=%s\n' "${scenario_file}"
  printf 'runId=%s\n' "${run_id}"
} > "${context_file}"

if [ "${sleep_before_heartbeat}" = "1" ] && [ "${sleep_ms}" -gt 0 ] 2>/dev/null; then
  sleep "$(awk "BEGIN { printf \"%.3f\", ${sleep_ms} / 1000 }")"
fi

if [ -n "${heartbeat_progress}" ] && [ -n "${NINTHWAVE_LAUNCH_ITEM_ID:-}" ]; then
  mkdir -p "${heartbeat_dir}"
  {
    printf '{\n'
    printf '  "id": "%s",\n' "$(json_escape "${NINTHWAVE_LAUNCH_ITEM_ID}")"
    printf '  "progress": %s,\n' "${heartbeat_progress}"
    printf '  "label": "%s",\n' "$(json_escape "${heartbeat_label}")"
    printf '  "ts": "1970-01-01T00:00:00.000Z"'
    if [ -n "${heartbeat_pr_number}" ]; then
      printf ',\n  "prNumber": %s\n' "${heartbeat_pr_number}"
    else
      printf '\n'
    fi
    printf '}\n'
  } > "${heartbeat_file}"
fi

if [ "${sleep_before_heartbeat}" != "1" ] && [ "${sleep_ms}" -gt 0 ] 2>/dev/null; then
  sleep "$(awk "BEGIN { printf \"%.3f\", ${sleep_ms} / 1000 }")"
fi

trap 'write_state signaled TERM; exit 0' TERM
trap 'write_state signaled INT; exit 0' INT

case "${behavior}" in
  success)
    write_state completed
    exit 0
    ;;
  exit)
    write_state failed
    exit "${exit_code}"
    ;;
  hang)
    write_state hanging
    while :; do
      sleep 1
    done
    ;;
  *)
    printf 'Unknown fake AI behavior: %s\n' "${behavior}" >&2
    write_state failed
    exit 64
    ;;
esac
