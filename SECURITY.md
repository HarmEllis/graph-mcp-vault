# Security Policy

## Supported Versions

Only the latest published release (`latest` tag on GitHub Container Registry) receives security fixes.
Older versions are not supported.

## Reporting a Vulnerability

**Do not open a public issue for security vulnerabilities.**

Please use GitHub's private vulnerability reporting feature:
**Security → Report a vulnerability** on this repository.

This opens a private Security Advisory visible only to maintainers.
Include:

- Description of the vulnerability and its impact
- Steps to reproduce (proof-of-concept if applicable)
- Affected versions or configurations
- Suggested fix if you have one

## Response Timeline

| Stage | Target |
|---|---|
| Initial acknowledgement | 7 days |
| Severity assessment | 14 days |
| Fix or mitigation | Best effort, depending on severity |

## Out of Scope

The following are not considered security vulnerabilities:

- Issues in self-hosted dependencies (Neo4j, your OIDC provider) outside this server's code
- Vulnerabilities that require physical access to the host
- Rate limiting beyond what the server enforces (defer to your reverse proxy / Bunkerweb config)
- Denial-of-service attacks requiring a valid, authenticated session
