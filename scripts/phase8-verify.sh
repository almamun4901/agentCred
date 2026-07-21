#!/bin/sh

set -eu

project_name="agentcred-phase8-verify"
postgres_port="${PHASE8_VERIFY_POSTGRES_PORT:-15432}"
redis_port="${PHASE8_VERIFY_REDIS_PORT:-16379}"
issuer_port="${PHASE8_VERIFY_ISSUER_PORT:-13000}"
agent_b_port="${PHASE8_VERIFY_AGENT_B_PORT:-13001}"

compose() {
  POSTGRES_PORT="$postgres_port" \
  REDIS_PORT="$redis_port" \
  ISSUER_PORT="$issuer_port" \
  AGENT_B_PORT="$agent_b_port" \
    docker compose -p "$project_name" "$@"
}

cleanup() {
  compose down --volumes --remove-orphans >/dev/null 2>&1 || true
}
trap cleanup EXIT INT TERM

fail() {
  printf 'Phase 8 verification failed: %s\n' "$1" >&2
  exit 1
}

compose config -q
compose up --build --detach --wait postgres redis key-init issuer agent-b

[ "$(compose exec -T issuer node -p 'process.getuid()')" = "10001" ] \
  || fail "issuer is not running as UID 10001"
[ "$(compose exec -T agent-b node -p 'process.getuid()')" = "10001" ] \
  || fail "Agent B is not running as UID 10001"

compose exec -T agent-b node -e \
  "if(require('node:fs').existsSync('/keys/private/private.pem'))process.exit(1)" \
  || fail "Agent B can access the signing private key"

issuer_image="$(compose images -q issuer)"
agent_b_image="$(compose images -q agent-b)"
[ -n "$issuer_image" ] || fail "issuer image was not built"
[ -n "$agent_b_image" ] || fail "Agent B image was not built"

[ "$(docker image inspect "$issuer_image" --format '{{.Config.User}}')" = "10001:10001" ] \
  || fail "issuer image does not declare its non-root user"
[ "$(docker image inspect "$agent_b_image" --format '{{.Config.User}}')" = "10001:10001" ] \
  || fail "Agent B image does not declare its non-root user"

assert_image_has_no_pem() {
  docker run --rm --entrypoint node "$1" -e \
    "const f=require('node:fs');const p=require('node:path');const w=d=>f.readdirSync(d,{withFileTypes:true}).flatMap(e=>e.isDirectory()?w(p.join(d,e.name)):[p.join(d,e.name)]);if(w('/app').some(x=>x.endsWith('.pem')||x.endsWith('.key')))process.exit(1)"
}
assert_image_has_no_pem "$issuer_image" \
  || fail "issuer runtime image contains a PEM or key file"
assert_image_has_no_pem "$agent_b_image" \
  || fail "Agent B runtime image contains a PEM or key file"

demo_output="$(compose --profile demo run --build --rm agent-a)"
printf '%s\n' "$demo_output"
printf '%s\n' "$demo_output" | grep -q '^DENIED 403 scope_exceeded' \
  || fail "containerized demo did not prove the overreach denial"
printf '%s\n' "$demo_output" | grep -q '^ALLOWED 200 ' \
  || fail "containerized demo did not prove the allowed request"

principal="$(printf '%s\n' "$demo_output" | sed -n 's/^principal=//p')"
case "$principal" in
  phase3-demo-[0-9a-f-]*) ;;
  *) fail "containerized demo returned an unexpected principal" ;;
esac

audit_rows="$(compose exec -T postgres psql -U agentcred -d agentcred -Atc \
  "SELECT decision || ':' || COALESCE(denial_reason, 'none') FROM verification_log WHERE principal = '$principal' ORDER BY id")"
expected_audit_rows="$(printf 'deny:scope_exceeded\nallow:none')"
[ "$audit_rows" = "$expected_audit_rows" ] \
  || fail "PostgreSQL does not contain the expected deny-then-allow audit evidence"

public_key_hash() {
  compose exec -T agent-b node -e \
    "const c=require('node:crypto');const f=require('node:fs');process.stdout.write(c.createHash('sha256').update(f.readFileSync('/keys/public/public.pem')).digest('hex'))"
}

public_key_before="$(public_key_hash)"
compose restart issuer agent-b >/dev/null
compose up --detach --wait issuer agent-b >/dev/null
public_key_after="$(public_key_hash)"
[ "$public_key_before" = "$public_key_after" ] \
  || fail "application restart replaced the signing identity"

compose exec -T issuer node -e \
  "fetch('http://127.0.0.1:3000/healthz').then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))" \
  || fail "issuer health check failed after restart"
compose exec -T agent-b node -e \
  "fetch('http://127.0.0.1:3001/healthz').then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))" \
  || fail "Agent B health check failed after restart"

printf 'Phase 8 container verification passed.\n'
