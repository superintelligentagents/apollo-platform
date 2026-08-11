# Presign API

Minimal Express API to issue presigned S3 POSTs for journeys uploads.

## Setup
```bash
cd backend
cp .env.example .env   # fill values
npm install
npm start              # or npm run dev for watch mode
```

Required env vars (see `.env.example`):
- `AWS_REGION`, `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`
- `S3_BUCKET`
- `UPLOAD_PREFIX` (e.g., `prolific/journeys/`)
- `MAX_FILE_BYTES` (e.g., `5000000`)
- `ALLOWED_ORIGIN` (comma-separated origins allowed for CORS, e.g., `https://yourdomain.com`)

## Endpoint
`POST /presign`
```json
{
  "participantId": "PID123",
  "studyId": "study-abc",
  "filename": "journeys.json",
  "contentType": "application/json"
}
```

Response:
```json
{
  "url": "https://bucket.s3.amazonaws.com",
  "fields": { "...": "..." },
  "key": "prolific/journeys/PID123/1700000000_journeys.json"
}
```

Production also exposes the explicit POST task-review and trajectory-review routes documented in `apollo-v2/README.md`, plus the bearer-authenticated read-only `GET /reporting/tasks` and `GET /reporting/trajectories` contracts documented in `REPORTING_API.md`.
API Gateway applies a 10 request/second global throttle and a 2 request/second `/presign`
throttle. The Lambda role can list only `prolific/journeys/*` and `v2-review/*`, and object
access is limited to those same prefixes.

Use `url` + `fields` in a multipart POST (the frontend does this).
