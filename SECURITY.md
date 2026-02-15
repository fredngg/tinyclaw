# Security Hardening — TinyClaw

This document describes the security measures added to this fork, what each one protects against, and the **trade-offs vs. the original setup**.

---

## 1. All CLI Execution Removed — HTTP API Only

**File:** [`src/lib/invoke.ts`](src/lib/invoke.ts)

**What changed:** The original setup spawned local CLI tools (Codex, Claude) as child processes with `--skip-git-repo-check` and `--dangerously-bypass-approvals-and-sandbox` flags. **All code paths that spawn local processes have been removed.** Every provider — including `openai` — now routes through the **OpenRouter HTTP API**. If `provider: "openai"` is set in settings, a deprecation warning is logged and the request is routed through OpenRouter (which supports OpenAI models natively).

**Protects against:** The original flags allowed the AI agent to run arbitrary shell commands without a sandbox or user approval. A prompt-injection attack could have escalated to full host access.

| | Original | This Fork |
|---|----------|-----------|
| AI invocation | Codex / Claude CLI with bypassed sandbox | OpenRouter HTTP API (network call only) |
| Host access | Full shell access for the agent | No shell access; HTTP response only |
| Approval flow | Bypassed | Not applicable (no local CLI) |
| `provider: "openai"` | Spawns `codex exec` as child process | Routed through OpenRouter with deprecation warning |

> [!WARNING]
> **Compromise:** If you relied on the agent executing local commands (e.g., running scripts, editing files on the host via the CLI), this is no longer possible. The agent can only respond with text.

---

## 2. File Access Restriction (Path Traversal Protection)

**File:** [`src/queue-processor.ts`](src/queue-processor.ts) — `collectFiles()`

**What changed:** The `[send_file:]` directive is now restricted to files within `~/.tinyclaw/files/` only. Three layers of defence:
1. **Absolute paths blocked** — `path.isAbsolute()` check
2. **`..` traversal blocked** — literal string check
3. **Symlink escape blocked** — resolved path must start with `FILES_DIR`

**Protects against:** A malicious or hallucinated agent response containing `[send_file: /etc/passwd]` or `[send_file: ../../.ssh/id_rsa]` would have the bot send sensitive host files over chat.

> [!WARNING]
> **Compromise:** Files outside `~/.tinyclaw/files/` cannot be sent, even legitimately. If the agent creates a file in its working directory and wants to share it, the file must be copied into the files directory first.

---

## 3. Log Scrubbing

**File:** [`src/queue-processor.ts`](src/queue-processor.ts), [`src/lib/logging.ts`](src/lib/logging.ts)

**What changed:** Full message content is redacted from log output. Logs now contain metadata only (agent ID, channel, timestamp, message length) rather than the raw user/agent message text.

**Protects against:** Log files or Docker stdout inadvertently leaking private conversations, API keys pasted in messages, or other sensitive content.

> [!IMPORTANT]
> **Compromise:** Debugging is harder. When something goes wrong with message processing, you won't see the actual message content in logs. You'll need to check the queue files in `~/.tinyclaw/queue/` directly.

---

## 4. No Runtime Dependency Installation

**File:** [`lib/daemon.sh`](lib/daemon.sh) — `start_daemon()`

**What changed:** The original daemon would auto-run `npm install` and `npm run build` at startup. This is now blocked — the daemon requires `node_modules/` and `dist/` to already exist.

**Protects against:** Supply-chain attacks where a compromised npm registry serves a malicious package version at runtime. By only using dependencies installed at build time, the attack window is limited to the CI/CD build step where it's auditable.

> [!WARNING]
> **Compromise:** You must run `npm ci && npm run build` manually (or in CI) before starting TinyClaw. If you pull new code, you must rebuild before restarting. The original setup handled this automatically.

---

## 5. Update Checksum Verification (SHA-256)

**File:** [`lib/update.sh`](lib/update.sh) — `do_update()`

**What changed:** When downloading an update bundle, the updater now:
1. Downloads a `.sha256` checksum file from the release
2. Verifies the bundle against the checksum using `shasum -a 256`
3. **Aborts the update** if verification fails
4. Warns and asks for confirmation if no checksum file is available

**Protects against:** Man-in-the-middle attacks or CDN compromises where the downloaded tarball is replaced with a malicious version.

> [!IMPORTANT]
> **Compromise:** You must publish a `.sha256` file alongside every release tarball. Without it, users will see a warning and must manually confirm. The original setup trusted the download implicitly.

---

## 6. Removed `curl | bash` Install Pattern

**Files:** [`README.md`](README.md), [`scripts/remote-install.sh`](scripts/remote-install.sh), [`docs/INSTALL.md`](docs/INSTALL.md)

**What changed:** The one-line `curl -fsSL ... | bash` install command has been replaced with a **download → inspect → run** pattern:
```bash
curl -fsSL -o /tmp/tinyclaw-install.sh https://raw.githubusercontent.com/fredngg/tinyclaw/main/scripts/remote-install.sh
# Inspect the script before running
less /tmp/tinyclaw-install.sh
bash /tmp/tinyclaw-install.sh
```

**Protects against:** Piping untrusted remote scripts directly into bash is dangerous — a partial download, MITM, or repository compromise could execute arbitrary code without the user ever seeing it.

> [!NOTE]
> **Compromise:** Installation now takes an extra step. Users must download, review, then run the script. This is a minor convenience trade-off for significantly better security hygiene.

---

## 7. Docker Containerization (Hardened)

**Files:** [`Dockerfile`](Dockerfile), [`docker-compose.yml`](docker-compose.yml), [`docker-entrypoint.sh`](docker-entrypoint.sh), [`.dockerignore`](.dockerignore)

### Security Layers

| Layer | Setting | What it does |
|-------|---------|-------------|
| **Non-root user** | `USER tinyclaw` (UID 1000) | Limits damage if container is compromised |
| **Read-only rootfs** | `read_only: true` | Prevents writing to the container filesystem |
| **Drop all capabilities** | `cap_drop: ALL` | Removes Linux kernel capabilities (no `CAP_NET_RAW`, `CAP_SYS_ADMIN`, etc.) |
| **No new privileges** | `no-new-privileges:true` | Prevents `setuid`/`setgid` escalation |
| **Resource limits** | CPU: 2, RAM: 2GB, PIDs: 256 | Prevents resource exhaustion (fork bombs, OOM) |
| **Named volumes only** | No bind mounts to host dirs | Prevents access to host filesystem |
| **Controlled tmpfs** | `/tmp`, `/run`, `/home` are tmpfs | Provides writable space without persisting data |
| **No secrets in image** | `.dockerignore` excludes `.env` | API keys are injected at runtime via `env_file` |
| **dumb-init** | PID 1 signal handling | Prevents zombie processes, graceful shutdown |
| **Entrypoint validation** | Checks env vars, refuses root | Fails fast if misconfigured |

### What the original setup looked like
The original TinyClaw runs directly on the host with:
- **Full host filesystem access** — agent can read/write anywhere the user can
- **Same user as the operator** — often running as a privileged user
- **Unrestricted network** — can connect to any external service
- **No resource limits** — a misbehaving process can consume all resources
- **Secrets in source tree** — `.env` files sitting alongside the code

> [!CAUTION]
> **Compromise:** Docker adds operational complexity. You need Docker installed, must manage volumes, and cannot directly interact with the tmux session the way you would on a bare-metal install. The `.tinyclaw/` data directory is inside a Docker volume rather than directly in your home directory, which changes backup and debugging workflows.

---

## 8. Cron Command Injection Fix (schedule skill)

**File:** [`.agents/skills/schedule/scripts/schedule.sh`](.agents/skills/schedule/scripts/schedule.sh) — `build_cron_command()`

**What changed:** The original code only escaped `"` in the message, then interpolated it into a nested single-quoted `bash -c` payload. A message containing `'` (single quote) could break out of the quoting context and execute arbitrary shell commands via cron.

**Fix:** The message is now **base64-encoded** before being placed into the crontab line. At execution time, cron decodes it with `base64 -d`. No user-controlled text is ever interpolated into a shell context. Additionally, messages with control characters (other than `\n` and `\t`) are rejected.

**Protects against:** An attacker who can influence the scheduled message content (e.g., via prompt injection making the agent call the schedule skill) could have executed arbitrary commands as the crontab user.

> [!NOTE]
> **Compromise:** Debugging crontab entries is slightly harder — the message is stored as base64, not plaintext. Use `echo '<base64>' | base64 -d` to inspect.

---

## Summary: Original vs. Hardened

| Area | Original | Hardened | Trade-off |
|------|----------|---------|-----------|
| AI execution | Local CLI with full shell | HTTP API only | No local command execution |
| File access | Unrestricted | `~/.tinyclaw/files/` only | Must stage files explicitly |
| Logging | Full message content | Metadata only | Harder to debug message issues |
| Dependencies | Auto-installed at runtime | Pre-built required | Manual rebuild after updates |
| Updates | Trust-on-download | SHA-256 verified | Must publish checksum with releases |
| Installation | `curl \| bash` | Download → inspect → run | Extra step |
| Runtime | Bare metal, user's shell | Docker, non-root, read-only | Requires Docker; volume management |
| Network | Unrestricted | Container-scoped | Need network policies for full lockdown |
| Secrets | In `.env` on disk | Injected at runtime only | Must configure `env_file` properly |
| Cron injection | Raw message in shell context | Base64-encoded payload | Crontab entries less human-readable |

---

## Recommendations

1. **Always publish `.sha256` files** alongside release tarballs
2. **Never run Docker as root** — the entrypoint will refuse to start
3. **Back up your volumes** — `docker volume ls` and `docker cp` for data recovery
4. **Add network egress rules** in production using Calico/Cilium to allowlist only required endpoints (OpenRouter, Discord, Telegram, WhatsApp)
5. **Rotate API keys regularly** — since they're injected via `.env`, rotation only requires a container restart
