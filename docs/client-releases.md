# Signed LAN client releases

The game HTTPS server publishes only `/client-release/manifest.json` and `/client-release/files/<sha256>`. The latter contains immutable content-addressed files, without authentication or access to other server files. Deploy payloads before atomically replacing the manifest; keep older payloads for in-progress downloads.

The envelope contains base64 `payload` and `signature`. The payload is UTF-8 JSON with schema 1, version, monotonically increasing integer sequence, and files (`path`, `size`, lowercase `sha256`). RSA PKCS#1 v1.5 SHA-256 signs the exact payload bytes. The client pins the release public key and the game server certificate. Signing private keys must remain outside Git, payloads, and the game server.

v0.6.0 launchers compare all managed file hashes before entering the lobby, download differences, then use a separate helper to replace files and relaunch. User preferences and login tokens are excluded. Running game processes prevent replacement. The helper validates again and saves a durable recovery journal and original files; interrupted operations roll back on the next launch. Older release sequences are rejected. An unreachable distribution server prevents launch and offers retry.

v0.5.2 and earlier do not have this mechanism and need one manual v0.6.0 install. This feature is distribution/integrity repair, not an anti-cheat boundary against users controlling their own PCs.

SSO is planned separately: the department master system will provide an OIDC identity provider; the game/exchange will act as relying parties. Existing accounts, balances, approval and local admin roles must be preserved. No OIDC endpoint is enabled in this release.
