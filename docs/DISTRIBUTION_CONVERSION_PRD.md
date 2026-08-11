# Archived MCP Distribution Decision Record

**Status:** Superseded on 2026-08-11

This document records why OilPriceAPI added keyless MCP demo access, explicit
client attribution, and official-registry publication. It is not a product
contract, current launch plan, customer cohort report, or release checklist.

Current public contracts live at:

- [OilPriceAPI product facts](https://api.oilpriceapi.com/product-facts.json)
- [OilPriceAPI MCP releases](https://github.com/OilpriceAPI/mcp-server/releases)
- [Official MCP registry](https://registry.modelcontextprotocol.io/)
- [npm package](https://www.npmjs.com/package/oilpriceapi-mcp)

## Decisions Retained

- A keyless MCP client can call the API's limited public demo path.
- Account keys unlock only the data and limits returned by the account and API.
- MCP calls carry versioned client attribution without exposing credentials.
- Release metadata is checked before publication.
- npm and MCP registry publication are sequential. Registry failure after npm
  is visible and recoverable; it is not described as atomic.
- Public registry metadata is read back and compared with the reviewed source
  after publication.

## Release Boundary

The npm package and official MCP registry record are the published artifacts.
`manifest.json` remains source metadata for compatibility testing; this record
does not claim an MCPB artifact, directory submission, or desktop installation.

## Privacy Boundary

Operational decisions use aggregate, non-customer-identifying evidence. Earlier
customer-level examples and dated cohort statistics were removed from this
public repository. Customer outreach and account changes require separate
approval and evidence and are outside this release process.

## Verification

A release candidate must pass unit tests, dependency audit, deterministic build,
source and packed-artifact claim checks, package installation smoke, protocol
scope tests, live keyless compatibility smoke, protected-main provenance, pinned
publisher validation, and bounded npm and registry readback.
