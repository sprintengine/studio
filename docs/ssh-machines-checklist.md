# SSH machines: the manual checklist

What the automated suites cannot show about Studio on an SSH machine (phase
8, `docs/design/studio-server/phase-8-ssh-remotes.md`), checked by hand
before a release that changes it. The dockerized `sshd` suites
(`STUDIO_TEST_DOCKER=1`, the `SSH machines` CI job) cover a Linux machine from
a macOS or Linux desktop. This list covers the rest: a Windows desktop, a
macOS machine, a jump host, and the app itself, end to end.

Use a machine you are allowed to install software on in your own home. The
examples call it `build-box`, with a user `dev`.

## 1. Add and connect (any desktop)

1. Settings › Machines › SSH machines. Type `build-box` (an alias in your
   `~/.ssh/config`), then Check.
   Expect: the route it resolves to, `dev@<host>:<port>`, and the jump host if
   your config names one. Nothing has connected yet.
2. Add it, then Connect.
   Expect, on a first connection: "New machine: build-box" with the key type
   and the SHA-256 fingerprint. Cancel is focused, not Trust.
3. Check the fingerprint against the machine (`ssh-keygen -lf
   /etc/ssh/ssh_host_ed25519_key.pub` there), then Trust and connect.
   Expect: your passphrase asked once if your key has one and is not in
   ssh-agent; "Installing Studio server <version> on build-box (N MB)…";
   "Starting the Studio server on build-box…"; then "Connected".
4. On build-box: `ls -la ~/.local/share/sprintengine-studio/data/run`.
   Expect: the directory `drwx------`, `owner-token` and `server.json`
   `-rw-------`. `ps -ef | grep -c "$(cat .../owner-token)"` finds only the
   grep itself. `ss -ltn` lists nothing new.

## 2. A chat there

1. New chat › the machine menu › build-box. Type the folder's full path on
   build-box, pick a chat engine installed there, and send a message.
   Expect: the chat runs, and the sidebar files it under that folder with the
   machine's name.
2. Close the laptop's lid for a minute mid-turn, then open it.
   Expect: "Reconnecting to build-box — last reached …" in Settings, then
   "Connected"; the turn finished on build-box while the lid was closed.
3. With the key not in ssh-agent: let the connection drop (turn Wi-Fi off and
   on). Expect: "build-box needs you to sign in." and no dialog until you click
   Connect.

## 3. The pane

1. Ask the agent on build-box to start a dev server on `127.0.0.1:5173` there
   and open it in the browser.
   Expect: the page from build-box in your pane, not anything this computer
   serves on 5173. Hot reload works when a file there changes.
2. Settings › Machines › build-box › Browser tabs' network: "Only its
   localhost". Open an outside site in that workspace's pane.
   Expect: it loads from this computer's network.
3. On this computer, while a build-box tab is open: `lsof -nP -iTCP -sTCP:LISTEN
   | grep 127.0.0.1` shows the forward's port; `curl -x http://127.0.0.1:<port>
   http://localhost:5173/` answers `407`. Close the tab: the port is gone a few
   seconds later.

## 4. A Windows desktop (no automated coverage yet)

1. `where ssh` lists `C:\Windows\System32\OpenSSH\ssh.exe` first; Settings ›
   Machines › build-box › Diagnostics names that one, even with Git for
   Windows' `ssh.exe` earlier on `PATH`.
2. The first connection's host-key dialog appears (the askpass `.cmd` shim
   runs), and the key lands in `%USERPROFILE%\.ssh\known_hosts`.
3. A key with a passphrase, with the Windows `ssh-agent` service off (the
   default): the passphrase dialog appears.

## 5. A macOS machine

1. Add a Mac you can SSH into. Expect: "Connected", and Settings notes that a
   CLI keeping its sign-in in the keychain cannot read it over SSH.
2. On that Mac: `ps -axo command | grep server.cjs` shows the server running
   from `~/.local/share/sprintengine-studio/server-<version>/`.

## 6. Upgrades and other versions

1. With a server of this version running, connect from a newer build.
   Expect: "Updating the Studio server on build-box from X to Y…", then
   "Connected"; a chat that was working there finished first (a minute at
   most).
2. Connect again from the older build. Expect: "build-box runs Studio server
   Y; this app is X. Update this app to use it." The server is not touched.
3. Stop server on build-box, then Forget. Expect: the server gone from `ps`
   there; the machine gone from Settings; its chats still on build-box.
