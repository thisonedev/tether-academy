# Testing generated packages

Requires an App ID / Secret Key from a SCORM Cloud account (Account -> Apps), saved in `test-lms/.env` (gitignored):

```
SCORM_CLOUD_APP_ID=...
SCORM_CLOUD_SECRET_KEY=...
```

`scorm-cloud-api.mjs` is a small v2 REST client (`uploadAndImportCourse`, `pollImportJob`, `createRegistration`, `buildLaunchLink`, `getRegistrationProgress`). Use it from a one-off script to upload the current package, create a registration, and print a launch link, then open that link yourself.
