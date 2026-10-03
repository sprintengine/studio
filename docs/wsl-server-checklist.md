# The Studio server in WSL: the manual checklist

These checks need a real Windows PC with WSL 2. Run them before the WSL
server's switch (`chatServer`) is turned on by default. The phase 7 spec asks
for this checklist (`docs/design/studio-server/phase-7-wsl-server.md`, section
9.3); this file turns it into steps. Owner ruling 2026-10-02 (decision R72):
the checklist is run by hand for the first release that ships the server, and
a self-hosted Windows runner with WSL 2 runs it before the default flips.

None of it can run on the hosted CI runners, which have no nested
virtualisation and so no WSL 2. Everything that can run without WSL already
runs on every commit, with a plain `sh` standing in for `wsl.exe`
(`src/server/wsl/*.test.ts`, `src/main/hosts/wsl-install.test.ts`).

Each step says what to do and, after **Expect:**, what you should see. Record
each result in the release notes of the release it gates: pass, or fail with
what you saw instead. Include the build and the output of `wsl --version`.

Commands marked **PowerShell** run in a Windows terminal. Commands marked
**distro** run in a shell inside the distribution (`wsl -d Ubuntu-24.04`).

## Set-up

1. Windows 11 with current updates. **PowerShell:** `wsl --version`.
   **Expect:** a WSL version line and a kernel version. If `wsl -l -v` shows
   VERSION 1 for the test distribution, convert it first.
2. **PowerShell:** `wsl --install -d Ubuntu-24.04`, then create the user.
   **distro:** install at least one agent CLI and sign it in (`claude`,
   `codex`). **Expect:** `claude --version` (or `codex --version`) prints a
   version.
3. **PowerShell:** `wsl --install -d Debian`, for the isolation checks.
4. Install the build under test with its installer, not a dev build.
   **Expect:** `%LOCALAPPDATA%\Programs\SprintEngine Studio\resources\wsl-server\server.cjs`
   and `build.json` exist.
   - To use a dev build instead, run `npm run build:server:wsl` first. If you
     skip it, a chat on the server fails with "this build shipped without the
     Studio server for WSL".
5. Know where the logs are.
   - Windows: `%APPDATA%\SprintEngine Studio\logs\`. Search for `WSL server`.
   - **distro:** `~/.local/state/sprintengine-studio/logs/`.
   - **distro:** the server's data is in
     `~/.local/share/sprintengine-studio/data/` (`data-<id>/` for a nightly
     or a pinned profile).
6. In the app, add a workspace inside the distribution:
   `\\wsl.localhost\Ubuntu-24.04\home\<you>\repo` (any git repository).

## A. Default off, the switch, and a first chat

1. Open Settings › Machines › WSL: Ubuntu-24.04 and expand it.
   **Expect:** "Chats run in" reads "One process per chat". There is no
   "Studio server" row.
2. Start a chat in the workspace and send a message.
   **Expect:** it replies as in the previous release.
   **distro:** `ls ~/.local/share/sprintengine-studio/`.
   **Expect:** no `server-<version>/` directory, and `ps -ef | grep server.cjs`
   shows nothing. With the switch off, nothing is installed or started.
3. Open New chat on a workspace in `C:\` bound to WSL: Ubuntu-24.04.
   **Expect:** no line about the Linux file system under the scope line.
4. Set "Chats run in" to "A Studio server in the distribution (preview)".
   **Expect:** a "Studio server" row appears, reading "Starts with the first
   chat here, and stops after ten minutes with nothing to do."
5. Start a new chat in the workspace and send a message.
   **Expect:** the Studio server row says "Starting WSL: Ubuntu-24.04…", then
   the reply arrives.
   **distro:** `ls ~/.local/share/sprintengine-studio/`.
   **Expect:** `server-<version>/` and `data/` (or `data-<id>/`).
   **distro:** `ps -ef | grep server.cjs`.
   **Expect:** exactly one server process.
6. Look at the Studio server row again.
   **Expect:** "Running, reached over loopback."
7. Go back to the chat from step 2, which started before the switch, and
   send a message.
   **Expect:** it keeps working until you stop it. A new chat in the same
   workspace runs on the server (step 5's `ps` still shows one server).
8. While the chat from step 5 is mid-reply, set the switch back to "One
   process per chat", then send another message in that chat.
   **Expect:** the chat finishes on the server and keeps working. A new chat
   in that workspace now runs one process per chat. Turn the switch on
   again for the rest of the checklist.
9. In a server chat, attach an image to a message, open a tool's details,
   revert a turn, and use "Edit from here" and "Fork from here".
   **Expect:** each works as it does for a chat on Windows.
10. Quit the app.
    **Expect:** within ten seconds, **distro:** `ps -ef | grep server.cjs`
    shows nothing. Start the app and send in the same chat.
    **Expect:** the chat resumes.

## B. Transports and the front door (spec V1, V3)

1. NAT mode, which is the default. Start a server chat.
   **Expect:** the Studio server row says "over loopback". Write down the
   time from sending to the first reply.
2. **distro:** `ss -ltnp | grep node`.
   **Expect:** the server's port is bound to `127.0.0.1` only. Never
   `0.0.0.0`, `*` or `[::]`.
3. Add `localhostForwarding=false` under `[wsl2]` in
   `%USERPROFILE%\.wslconfig`. **PowerShell:** `wsl --shutdown`. Send in a
   server chat.
   **Expect:** the chat works. The row says "Running, reached through the
   stdio bridge." with the reason loopback did not work.
4. Remove that line. Set `networkingMode=mirrored` under `[wsl2]`.
   **PowerShell:** `wsl --shutdown`. Send in a server chat.
   **Expect:** "over loopback" again. Repeat step 2 and get the same result.
   **PowerShell:** `Get-NetTCPConnection -State Listen | Where-Object LocalPort -eq <port>`.
   **Expect:** only `127.0.0.1`, never `0.0.0.0` or a LAN address.
5. Check that the door refuses a stranger. With a server running, find its
   port (step 2). **PowerShell:**
   `$c = New-Object Net.Sockets.TcpClient('127.0.0.1', <port>); $s = $c.GetStream(); $w = New-Object IO.StreamWriter($s); $w.WriteLine('{"t":"hello"}'); $w.Flush(); Start-Sleep 1; $c.Close()`.
   **Expect:** in the distribution's server log, a line "Refused a connection
   on the loopback door". Chats keep working.
6. V3 is informational: what Windows reaches when a Windows process already
   holds the port. **PowerShell:** `python -m http.server 50123 --bind 127.0.0.1`.
   **distro:** `python3 -m http.server 50123 --bind 127.0.0.1`.
   **PowerShell:** `curl.exe http://127.0.0.1:50123/`. Write down which one
   answered. Either answer is safe, because the proof refuses a decoy
   (`front-door.test.ts`).
7. Set "How Windows reaches it" to "Always the bridge" and quit and restart
   the app. Send in a server chat.
   **Expect:** the row says "through the stdio bridge". Repeat step 2.
   **Expect:** no listening port for the server.

## C. Lifetime (spec V2, V9)

1. Leave the app idle, with no chat working, for ten minutes.
   **Expect:** **distro:** `ps -ef | grep server.cjs` shows nothing. The row
   says the server starts with the first chat.
2. Start a long reply. Mid-reply, **PowerShell:** `wsl --shutdown`.
   **Expect:** the turn shows as interrupted, and the row says "WSL was shut
   down…". **PowerShell:** `wsl -l -v` still shows the distribution
   `Stopped` a minute later, because nothing restarted it. Send again.
   **Expect:** the VM starts, then the server, and the chat resumes.
3. Mid-reply, **distro:** `kill -9 <pid of server.cjs>`.
   **Expect:** the row says "stopped unexpectedly". Send within two seconds.
   **Expect:** told when it is tried again. Send a few seconds later.
   **Expect:** the server restarts and replies.
4. Sleep the PC mid-reply, wake it, and send again.
   **Expect:** a reply, from the same server or a restarted one.
5. V2 is informational. With the app quit, start a server by hand in the
   distribution, close the `wsl.exe` window that started it, and check
   whether the VM stays up (`wsl -l -v`). The design does not rely on it.

## D. Files, git and `C:\` (spec V4, V5)

1. Open New chat on a workspace in `C:\` bound to WSL: Ubuntu-24.04, with
   the switch on.
   **Expect:** "Faster in the Linux file system: clone into ~/ in this
   distribution." under the scope line. The chat still starts.
   **distro:** `ps -ef | grep -E 'claude|codex'`.
   **Expect:** its working directory is under `/mnt/c/...`.
2. V4: in a repository of about 50,000 files, time `git status` and a
   mention search three ways: on ext4 through the server, on `/mnt/c`
   through the server, and natively on `C:\` with "One process per chat".
   Write the three numbers down.
3. V5: with the Windows-side workspace open, run a server chat on `/mnt/c`
   for several turns.
   **Expect:** the chat list and the transcript stay intact, with no
   duplicated or missing turns.
4. **distro:** add `[automount]` and `root = /win/` to `/etc/wsl.conf`.
   **PowerShell:** `wsl --terminate Ubuntu-24.04`. Send in a `C:\`
   workspace's server chat.
   **Expect:** the agent runs under `/win/c/...`.
5. Change that section to `enabled = false` and terminate the distribution
   again. Send in the `C:\` workspace's server chat.
   **Expect:** the chat is refused with a message saying automount is off in
   `/etc/wsl.conf`. Remove the section afterwards.

## E. Agents, tools and sign-in (spec V7, V10)

1. In a server chat, ask the agent to list Studio's tools.
   **Expect:** the core's tools, plus `browser` and `canvas`. With the app's
   server in its own process (section G), also `editor`, `tour`, `terminal`
   and `agent`.
2. Ask the agent to open a page in the browser pane.
   **Expect:** the Windows pane opens it.
3. Out of process (section G), ask the agent to open
   `/home/<you>/repo/README.md` in the editor, then `~/repo/README.md`.
   **Expect:** the first opens the file in the Windows editor. The second is
   refused with a message asking for the absolute path.
4. Install a CLI with nvm or into `~/.local/bin`, quit the app, start it,
   and use that CLI in a server chat.
   **Expect:** it is found. The login environment is read once, when the
   server starts.
5. V10: **distro:** sign each CLI out. Sign in again from a server chat.
   **Expect:** the sign-in works and the next message replies.
6. V7: behind a corporate VPN, or with `HTTPS_PROXY` set in `~/.profile`,
   send in a server chat.
   **Expect:** the chat reaches its provider.

## F. Isolation, versions and data (spec 8.6–8.11, V8)

1. Turn the switch on for Debian too, and run a chat in each distribution
   at once.
   **Expect:** two servers and two data directories. **distro (Debian):**
   kill its server. **Expect:** the Ubuntu chat keeps working.
2. On a spare distribution, **PowerShell:** `wsl --set-version <name> 1`.
   **Expect:** its "Chats run in" control is greyed out. If its switch was
   on before the conversion, a chat there is refused with "Convert it with
   "wsl --set-version <name> 2"".
3. **PowerShell:** `wsl --unregister` a spare distribution whose switch is
   on, then send in a chat bound to it.
   **Expect:** a readable message saying the distribution is not installed,
   with no stray characters between the letters.
4. V8: **PowerShell:** `wsl --manage <distro> --set-default-user <other>`,
   then send in a server chat.
   **Expect:** the server runs as the new user, in that user's home, with its
   own data. Chats made as the old user stay in the old user's home.
5. Upgrade: with a server running, install the next build and send a
   message.
   **Expect:** `server-<new>/` appears beside the old tree. The old tree is
   pruned on a later install, once nothing runs from it. `data/` is
   untouched.
6. Run the installed build and a nightly side by side, both with the switch
   on, and send in each.
   **Expect:** two servers, one on `data/` and one on `data-<id>/`, and both
   reply.

## G. Out of process

1. Settings: turn on "Run Studio server in its own process" and restart.
2. With the switch off for Ubuntu-24.04 (turn it off in process first, then
   restart), start a chat in the WSL workspace.
   **Expect:** the chat does not start. The message says the WSL helper does
   not run while Studio server is in its own process. **distro:** nothing is
   installed or started (same check as A2). This is how phase 6 left it.
3. Open Settings › Machines.
   **Expect:** no "Chats run in" or "Studio server" rows out of process.
4. Turn the server back in process, turn the switch on, then go out of
   process again. Start a chat in the WSL 2 workspace.
   **Expect:** it starts on the server and replies.

## H. Defender (spec V11)

1. With real-time protection on, in a fresh distribution with the switch on,
   time the first install and the first chat. The install is the Node
   download, then the server tree.
   **Expect:** both finish. Write the times down.

## Throughput

1. Over loopback, and again over the bridge, send a 10 MiB image and open a
   tool detail of about 64 MiB.
   **Expect:** both arrive each way. Write down how long each took.
