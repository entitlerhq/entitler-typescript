# Versioning and support

The SDK follows semantic versioning. Before 1.0.0, a minor release may change the public API; each
change is listed in the [changelog](../CHANGELOG.md).

## Supported runtimes

| Runtime | Supported |
| --- | --- |
| Node.js | every release in active or maintenance LTS: 22 and 24 today |
| Bun | the current release |
| Deno | the current release |
| Cloudflare Workers | the current runtime |
| Browsers | evergreen browsers, in a secure context (HTTPS or localhost) |

The SDK uses only `fetch`, WebCrypto and other web-standard APIs, so one build runs everywhere. A
Node.js release leaves the supported list when it reaches its end of life.

## The API

The SDK is built against the Entitler API as documented at `https://api.entitler.dev`. It ignores
fields it does not know and keeps unknown enum values as strings, so newer API releases keep working
with older SDKs.

Report security issues privately, as [SECURITY.md](../SECURITY.md) describes.
