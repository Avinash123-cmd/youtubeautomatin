# Render local storage: exact configuration and serving contract

Investigated 2026-11-16 against the existing storage adapter, MediaController and environment parser.

## Exact values for the requested API

Set these three variables on the existing Render API service:

```dotenv
STORAGE_DRIVER=local
STORAGE_LOCAL_ROOT=/var/data/clipforge/objects
STORAGE_LOCAL_PUBLIC_BASE_URL=https://youtubeautomatin.onrender.com/media
```

These are deployment-specific example values, not hardcoded application defaults. The public base
includes **/media**, not /api/media and not a filesystem path. The previous startup error occurs
because env.ts requires both local settings whenever STORAGE_DRIVER=local; validation is unchanged.
Set the values, preserve existing secrets/database configuration, and redeploy the service.

## Required durable disk

In Render's existing API service, attach a **Persistent Disk**:

| Setting | Value |
| --- | --- |
| Service | Existing API service youtubeautomatin |
| Disk name | clipforge-media (operator-chosen name) |
| Mount path | **/var/data** |
| Suggested initial capacity | 10 GB; choose capacity for your actual media workload and monitor free space |
| Service instance | A paid instance type that supports persistent disks |

Only writes beneath the mount are durable. /tmp, the default source checkout and a plain directory
without an attached disk are ephemeral. Render documents paid-instance disk support, /var/data as a
suitable mount, and runtime-only disk availability at [Persistent Disks](https://render.com/docs/disks).
Creating a directory alone does not create a persistent disk. The disk must be mounted when the
service runs and writable by the service user. Do not mount it over source code or node_modules.
No disk was provisioned, resized or deleted by this repository change.

The adapter creates root/parent directories recursively **on the first write**, not in its
constructor or during environment validation. Successful startup alone does not prove disk
permissions or durability. Put an authorized test upload through the actual service, restart the
service and verify it remains accessible. Do not remove old storage before migrating existing
objects; changing STORAGE_LOCAL_ROOT does not copy files automatically. Preserve all database
records and existing files, and back them up before changing an existing disk setup.

Render disks are attached to a service/instance, not a shared filesystem across API, independent
workers and video-processor services. This configuration makes API-local bytes durable; it does
not make a distributed video pipeline share them. Use durable S3-compatible storage or an explicitly
designed shared processing arrangement for separate services. Do not assume attaching a disk to
the API also makes that path readable in another worker/container. WORK_DIR is separate staging/
processing storage; existing work files are not made persistent by changing STORAGE_LOCAL_ROOT.

## Actual delivery routes — no invented static path

There is **no** express.static, useStaticAssets or ServeStaticModule mount of STORAGE_LOCAL_ROOT.
MediaController is registered in AppModule at @Controller('media'):

| Route | Behavior |
| --- | --- |
| GET /media/sources/:sourceId | Authenticated session; DB lookup scoped by ctx.workspaceId; stream stored source key |
| GET /media/clips/:variantId | Authenticated session; DB lookup scopes variant through clip.workspaceId; stream mediaAsset key |
| GET /media/health/probe.mp4 | Public embedded MP4 probe, not a file read from the storage root |

StorageService resolves the DB-selected key under STORAGE_LOCAL_ROOT; the same root is used for
writes, size queries, full reads and ranged reads. MediaController sets private cache headers,
content length/type and Range support; missing files produce 404. The global session guard protects
the two private ID routes. Only the embedded health probe is public.

STORAGE_LOCAL_PUBLIC_BASE_URL is used by StorageService.publicUrl(key), which concatenates base +
key. /media is the correct base for its existing health/probe.mp4 call, but **there is no generic
/media/<raw-storage-key> route**. Arbitrary raw-key URLs returned by publicUrl do not become playable
or publicly downloadable just because this setting uses HTTPS. Some source metadata currently
uses that helper; use the authorized ID-based media routes for private playback. The primary clip
and job playback code already selects these routes for local media. This investigation does not
invent a wildcard route or weaken session/workspace protection to make raw-key URLs work.

A public health probe proves network reachability only, not readback of your stored private files.
Likewise expectPublicHttps checks URL syntax only: it is not proof of anonymous media access,
a working Instagram import, disk read/write permissions or a complete publishing pipeline. Local
private media is not automatically suitable for external platforms that need anonymous HTTPS
retrieval. The existing local driver must not be advertised as a public object store.

## Security and upload-limit findings

- StorageService.assertSafeKey rejects empty keys, absolute slash paths, '..' and backslashes;
  localPath additionally resolves/normalizes and verifies root containment. HTTP media routes
  accept IDs, not keys supplied by the caller, and look up storage keys within the authenticated
  workspace. Keep the disk private to the service account; the lexical check is not a sandbox
  against a malicious OS user creating symlinks inside the root. No broad static mount was added.
- MediaValidationService checks allowed extensions (.mp4/.mov/.webm/.mkv/.m4v), actual file header
  signatures and declared MIME compatibility; it calls the existing video-processor ffprobe wrapper
  and checks codecs/duration. An asserted video MIME alone is insufficient. The storage adapter
  itself is a byte store; it is not the upload validation boundary.
- Source initiation checks the configured processing.max_file_size_bytes. There is no universal
  hardcoded total upload limit to invent here: inspect the actual workspace configuration.
- Local POST /api/sources/upload/part uses authenticated/CSRF-protected routes and Multer
  memoryStorage with a **64 MiB maximum per chunk**. It is not a 64 MiB total-file limit. Runtime
  UPLOAD_PART_SIZE_MIB is 1–64 MiB (default 16). Part indices and write offsets are checked against
  declared size, and completion checks size, MIME/container and other validation before accepting
  the object. The 2 MiB JSON parser limit is not a multipart-video file-size limit.
- The application does not enforce disk quota/free-space reservations in StorageService. Monitor
  capacity; a full/unwritable disk remains an operational failure. Do not disable validation or
  expose private files as a workaround.

## Changes and tests

Changed files:

- .env.example: exact three values above, mount requirement and private-route/probe clarification.
- docs/render-local-storage.md: this report.
- docs/render-api-production.md: correct the previous origin-only description to the real /media
  base and link this contract.
- docs/DOCUMENT-INDEX.md: index this report.
- tests/unit/local-storage.test.ts: real temporary filesystem writes/reads/ranges, recursive directory
  creation, traversal rejection, route/public metadata, workspace-scoped DB-query checks and
  malformed MIME/size/extension checks. Only database lookups are test doubles; no real user files
  or database were accessed.

Verification:

- npm install: passed.
- Full root production compilation build (all workspace packages, Prisma generation, API and Next):
  passed with sandbox-only engine-free Prisma generation because native-engine downloads are
  restricted here. Never apply the sandbox Prisma flags to Render.
- Targeted local-storage/source-library tests: **13 passed** (9 storage and 4 source tests).
- Full tests and final structure/diff checks are reported with the task result.

No application logic, environment validation, production disk, authentication, DB schema or public
file-serving policy changed. Native-engine deployment, real Render disk readback across restarts,
service permissions and live authenticated uploads remain unverified.
