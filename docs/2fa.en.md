# Umbra console 2FA operations guide

Starting with `v0.1.5`, the Umbra web console requires an administrator password and TOTP two-factor authentication by default. This guide covers initial enrollment, upgrades, recovery codes, offline reset, and configuration.

## Default behavior

- 2FA is enabled when `UMBRA_2FA` is unset or set to `on`.
- A new installation sets the administrator password and then enrolls an authenticator. No full console session is issued before enrollment succeeds.
- Normal login uses the password plus a six-digit TOTP. The password plus one unused recovery code also works.
- Standard TOTP applications such as 1Password, Google Authenticator, and Microsoft Authenticator are supported.
- TOTP depends on time. Enable time synchronization on both the gateway and phone.

## Initial enrollment

1. Open the console through an SSH tunnel or HTTPS.
2. Set an administrator password of at least eight characters.
3. Scan the QR code with an authenticator, or enter the displayed TOTP secret manually.
4. Submit the generated six-digit code to confirm enrollment.
5. Download or copy the 10 recovery codes and keep them offline.

Recovery codes are displayed once and each code can be used only once. If the page is closed before they are saved, sign in with TOTP and generate a replacement set under **Deploy → Console authentication**. The old set becomes invalid.

## Upgrading from a release without 2FA

When upgrading from `v0.1.4` or earlier to `v0.1.5` or later:

- the existing administrator password is retained;
- all existing console sessions are revoked;
- the gateway creates a mode-`0600` `2fa-bootstrap` file in `-tls-dir`;
- the first migration login requires the existing password and this migration code, followed by authenticator enrollment.

Read the migration code on the gateway:

```bash
# Docker Compose
docker exec umbrad cat /var/lib/umbra/2fa-bootstrap

# Default binary deployment path
sudo cat /var/lib/umbra/2fa-bootstrap
```

The migration code is not written to logs, and the file is deleted after enrollment. Replace the path if the deployment uses a different `-tls-dir`.

## Normal login and recovery codes

- Normal login: administrator password + current six-digit code.
- Phone unavailable: administrator password + any unused recovery code.
- A recovery code is invalidated immediately after use, and other console sessions are revoked.
- After login, use **Deploy → Console authentication** to change the password, replace the authenticator, or generate new recovery codes.
- Password, authenticator, and recovery-code changes revoke other console sessions.

Do not store recovery codes together with the administrator password.

## Offline reset

Use an offline reset only after losing both the phone and every recovery code. The command must acquire the exclusive `tls-dir` lock, so stop the running `umbrad` process first.

Binary or systemd deployment:

```bash
sudo systemctl stop umbrad
sudo umbrad -reset-2fa -tls-dir /var/lib/umbra
sudo systemctl start umbrad
sudo cat /var/lib/umbra/2fa-bootstrap
```

Docker Compose deployment:

```bash
docker compose -f deploy/compose.gate.yml stop umbrad
docker compose -f deploy/compose.gate.yml run --rm umbrad \
  -reset-2fa -tls-dir /var/lib/umbra
docker compose -f deploy/compose.gate.yml up -d umbrad
docker exec umbrad cat /var/lib/umbra/2fa-bootstrap
```

The reset retains the administrator password, removes the old TOTP binding and recovery codes, revokes all console sessions, and creates a new migration code. Use the existing password and new migration code to enroll again.

## Environment variables

| Setting                               | Behavior                                                                                  |
| ------------------------------------- | ----------------------------------------------------------------------------------------- |
| `UMBRA_2FA=on` or unset               | Enables 2FA; this is the default                                                          |
| `UMBRA_2FA=off`                       | Temporarily requires only the password and retains any existing binding                   |
| Any other `UMBRA_2FA` value           | Refuses to start                                                                          |
| `UMBRA_LOGIN=off`                     | Skips all console authentication; only for controlled development or preview environments |
| `GROK_AGENT` or `GROK_PROJECT_ID` set | Also skips all console authentication; preview use only                                   |

Restart or recreate the gateway after changing an environment variable. While 2FA is off:

- authenticator replacement and recovery-code regeneration are unavailable remotely;
- changing the administrator password still requires the current TOTP or a recovery code when a binding exists;
- password-only sessions issued while off become invalid as soon as 2FA is enabled again;
- the existing TOTP secret and recovery codes are not deleted.

Do not disable 2FA in production, and never use the preview authentication-bypass variables on a production gateway.

## Backups and security boundaries

- Back up the complete `-tls-dir`, not only certificate files.
- `control.json` contains the administrator password hash, symmetric TOTP secret, and recovery-code hashes. Exposure of `tls-dir` reveals the TOTP secret and enables offline password guessing.
- Never commit or share `tls-dir`, `2fa-bootstrap`, QR codes, TOTP secrets, or recovery codes.
- TOTP protects against password disclosure, credential stuffing, and ordinary brute force, but not a real-time phishing proxy. Verify the console address and TLS before entering a code.
- WebAuthn/FIDO2 can be added in the future for stronger phishing resistance.

See [2fa-design.md](2fa-design.md) for the detailed implementation and security specification.
