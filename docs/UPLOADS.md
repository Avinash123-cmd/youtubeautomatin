# Browser uploads

The upload screen supports both storage drivers:

- With `STORAGE_DRIVER=local`, the browser posts each chunk to the same-origin API route. The API assembles the file, validates it, and stores it.
- With `STORAGE_DRIVER=s3`, the API creates a multipart upload and returns short-lived presigned part URLs. The browser uploads each chunk directly to S3/R2, collects each response `ETag`, and sends those ETags back to the API to complete and validate the object.

Direct S3/R2 upload avoids sending large media files through the web/API proxy. The app never receives the S3 secret key in the browser.

## Bucket CORS

For the S3-compatible bucket, allow the dashboard origin to `PUT` parts and expose `ETag`. Replace the example origin with the exact origin in `APP_URL` (include separate entries for each local development origin you use).

```json
[
  {
    "AllowedOrigins": ["https://clips.example.com"],
    "AllowedMethods": ["PUT"],
    "AllowedHeaders": ["*"],
    "ExposeHeaders": ["ETag"],
    "MaxAgeSeconds": 3600
  }
]
```

AWS S3 and Cloudflare R2 endpoint domains are allowed by the dashboard Content Security Policy. If you use a custom S3-compatible endpoint, set `UPLOAD_CSP_ORIGINS` on the **web build** to its comma-separated origin(s), for example `https://objects.example.net`. The development and production Compose files use `S3_ENDPOINT` as the default for that build setting. Rebuild the web app after changing it.

The presigned URLs expire after one hour. Keep `UPLOAD_PART_SIZE_MIB` at or above 5 for S3/R2 multipart uploads; local storage also uses the configured part size. The API rejects a completion unless every declared S3 part has a valid part number and ETag.
