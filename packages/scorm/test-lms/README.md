# Testing generated packages

No Docker, no browser-automation dependency in the repo.

## Mock LMS

```bash
pnpm generate-scorm --qvac
node packages/scorm/test-lms/mock-lms-server.mjs
```

Serves the generated package under a deliberately non-root path with a mock SCORM 1.2 `API`. Open the printed URL in a browser.

## SCORM Cloud (real LMS)

Requires an App ID / Secret Key from a SCORM Cloud account (Account -> Apps), saved in `test-lms/.env` (gitignored):

```
SCORM_CLOUD_APP_ID=...
SCORM_CLOUD_SECRET_KEY=...
```

`scorm-cloud-api.mjs` is a small v2 REST client (`uploadAndImportCourse`, `pollImportJob`, `createRegistration`, `buildLaunchLink`, `getRegistrationProgress`). Use it from a one-off script to upload the current package, create a registration, and print a launch link, then open that link yourself.
