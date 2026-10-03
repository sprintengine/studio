# The Studio server in WSL: the manual checklist

What has to be checked by hand, on a real Windows PC with WSL 2, before the
WSL server's switch (`chatServer`) is turned on by default. It is the
checklist the phase 7 spec asks for (`docs/design/studio-server/
phase-7-wsl-server.md`, section 9.3), written as steps. Owner ruling
2026-10-02 (decision R72): this checklist is run by hand for the first
release that ships the server, and a self-hosted Windows runner with WSL 2
runs it before the default flips.

Nothing here can run on the hosted CI runners: they have no nested
virtualisation, so no WSL 2. Everything that can run without WSL already
does, on every commit, with a plain `sh` standing in for `wsl.exe`
(`src/server/wsl/*.test.ts`, `src/main/hosts/wsl-install.test.ts`).

Record each result (pass, fail with what you saw, the build and the WSL
version from `wsl --version`) in the release notes of the release it gates.

## Set-up

- Windows 11, current updates. `wsl --version` reports WSL 2.
- An Ubuntu 24.04 distribution (`wsl --install -d Ubuntu-24.04`), with at
  least one agent CLI installed and signed in inside it (`claude`, `codex`).
- A second distribution (Debian is enough) for the isolation checks.
- The build under test, installed (not a dev build): the installer ships the
  server tree as `resources\wsl-server`.
- For a dev build instead: `npm run build:server:wsl` first, or the app says
  "this build shipped without the Studio server for WSL".
- Logs: `%APPDATA%\SprintEngine Studio\logs\` on Windows (search
  `WSL server`), and inside the distribution
  `~/.local/state/sprintengine-studio/logs/` and
  `~/.local/share/sprintengine-studio/data*/`.

## A. The switch, and a first chat

1. Settings › Machines › WSL: Ubuntu-24.04 › expand. "Chats run in" reads
   "One process per chat". Start a chat in a workspace inside the distribution
   (`\\wsl.localhost\Ubuntu-24.04\home\<you>\repo`): it works as before.
2. Set "Chats run in" to "A Studio server in the distribution (preview)".
   Start a new chat in the same workspace. The first send shows the start
   ("Starting WSL: Ubuntu-24.04…" in Settings), then the reply.
   - Inside the distribution: `ls ~/.local/share/sprintengine-studio/` shows
     `server-<version>/` and `data/` (or `data-<id>/` for a nightly or a
     pinned profile).
   - `ps -ef | grep server.cjs` shows one server.
3. Settings shows "Running, reached over loopback."
4. The chat that was already open (started before the switch) keeps working
   until you stop it; a new one in that workspace runs on the server.
5. Send a message with an image attached, open a tool's details, revert a
   turn, use "Edit from here" and "Fork from here". Each works as on Windows.
6. Quit the app. Within ten seconds `ps` in the distribution shows no
   `server.cjs`. Start the app and send again: the chat resumes.

## B. Transports (spec V1, V3)

1. NAT mode (the default): Settings says "over loopback". Note the time from
   the start to the first reply.
2. Add `localhostForwarding=false` under `[wsl2]` in `%USERPROFILE%\.wslconfig`,
   run `wsl --shutdown`, send again. Settings says "through the stdio bridge"
   with the reason (loopback did not work). The chat works.
3. Mirrored mode (`networkingMode=mirrored`), forwarding back on: loopback
   again. In the distribution, `ss -ltnp | grep node` shows the server's port
   bound to `127.0.0.1` only, never `0.0.0.0` or `*`.
4. Squatter (V3), the behaviour the proof exists for: on Windows, hold a
   port (`python -m http.server 50123 --bind 127.0.0.1` in PowerShell); in
   the distribution, listen on the same number
   (`python3 -m http.server 50123 --bind 127.0.0.1`); from Windows,
   `curl http://127.0.0.1:50123/` and write down which one answered. Then
   check the app's log after a normal start: no "Refused a connection" lines.
   (A decoy that answers is refused without learning anything:
   `front-door.test.ts`.)
5. "How Windows reaches it: Always the bridge": the next start uses the
   bridge and opens no loopback port (`ss -ltn` shows none for the server).

## C. Lifetime (spec V2, V9)

1. Leave the app idle with no chat working for ten minutes: the server exits
   (`ps`), Settings says it starts with the first chat.
2. Mid-reply, run `wsl --shutdown` in a Windows terminal. The turn shows as
   interrupted, Settings says "WSL was shut down…", and nothing starts the VM
   again until you send. Sending starts it, and the chat resumes.
3. Mid-reply, `kill -9` the server's pid inside the distribution. Settings
   says it stopped unexpectedly; a send within a few seconds is told when it
   is tried again; a later send restarts it.
4. Sleep the PC mid-reply, wake it, send again.
5. V2 (informational): with no app running, does a server you start by hand
   in the distribution keep the instance alive after its `wsl.exe` exits?
   The design does not rely on it.

## D. Files, git and `C:\` (spec V4, V5)

1. A workspace on a Windows drive bound to WSL: New chat shows "Faster in the
   Linux file system: clone into ~/ in this distribution." The chat still
   runs, on the server, under `/mnt/c/...`.
2. V4: in a large repository (about 50,000 files), time `git status` and a
   mention search: on ext4 through the server, on `/mnt/c` through the
   server, and natively on `C:\` with "One process per chat". Write the three
   numbers down.
3. V5: with the Windows-side workspace open, run a chat on `/mnt/c` that
   writes several turns. The chat list and transcript stay intact
   (sidecar appends and renames over the drive mount).
4. A distribution with `[automount] root = /win/` in `/etc/wsl.conf`
   (restart it after the edit): a `C:\` workspace's chat runs under
   `/win/c/...`. With `enabled = false`, the chat is refused with a message
   saying automount is off.

## E. Agents, tools and sign-in (spec V7, V10)

1. In a server chat, ask the agent to list Studio's tools: the core's tools
   are there, and (out of process) `browser`, `canvas`, `editor`, `tour`,
   `terminal` and `agent` tools too. Ask it to open a page in the browser
   pane: the Windows pane opens it.
2. A CLI installed with nvm or `~/.local/bin` is found (the login
   environment is read once at the server's start).
3. V10: sign each CLI out inside the distribution and sign in again from a
   chat on the server.
4. V7: behind a corporate VPN or an HTTP proxy set in the login profile
   (`HTTPS_PROXY`), a chat on the server reaches its provider.

## F. Isolation, versions and data (spec 8.6–8.11, V8)

1. Turn the switch on for Debian too, chat in both at once: two servers, two
   data directories, and a failure in one (kill it) leaves the other running.
2. A WSL 1 distribution (`wsl --set-version <name> 1` on a spare one): the
   switch is greyed out in Settings, and a chat there with the desktop's
   server out of process is refused with "Convert it with wsl --set-version
   <name> 2".
3. V8: change the default user (`wsl --manage <distro> --set-default-user`):
   the next start uses the new user's home and its own data; chats made as the
   old user stay in that user's home.
4. Upgrade: with a server running, install the next build and send a message.
   The new version's tree appears beside the old (`server-<new>/`), the old
   one is pruned on a later install once nothing runs from it, and `data/`
   is untouched.

## G. Out of process

1. Settings › Advanced: run the app's server in a process of its own, restart.
2. Settings › Machines: "Chats run in" is fixed to the Studio server, with a
   line saying why.
3. A chat in a WSL 2 workspace starts and replies (before phase 7 it did not
   start at all out of process).

## H. Defender (spec V11)

1. With real-time protection on, time the first install into a fresh
   distribution (the Node download, then the server tree) and the first
   chat.

## Throughput

A 64 MiB tool detail and a 10 MiB image, each over loopback and over the
bridge: both arrive, and note how long each took.
