# Security Policy

## Reporting a vulnerability

Please report vulnerabilities privately through GitHub: open the **Security** tab of this repository and choose **Report a vulnerability** (GitHub private vulnerability reporting). Include the affected version or commit, the steps to reproduce, and the impact you see.

If private reporting is not available to you, open a regular [GitHub Issue](../../issues) that says you found a security problem, **without exploit details**, and a maintainer will arrange a private channel.

## Scope

Nightshift runs locally. The server listens on `127.0.0.1` only, rejects requests whose `Host` or `Origin` is not local or whose body is not `application/json`, and launches `claude` agents in your project folders with the permission mode you configure. Reports about bypassing those protections, escaping the project folder, or leaking local data are in scope.

Running agents with `bypassPermissions` lets them run any command in the project folder; that is documented behavior, not a vulnerability.

## Supported versions

Only the latest commit on `main` receives fixes.
