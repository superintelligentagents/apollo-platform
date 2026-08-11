import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import { S3Client } from "@aws-sdk/client-s3";
import { createPresignedPost } from "@aws-sdk/s3-presigned-post";

dotenv.config();

const app = express();
app.use(express.json({ limit: "1mb" }));
app.use(
  cors({
    origin: process.env.ALLOWED_ORIGIN?.split(",").map((v) => v.trim()),
    methods: ["POST", "OPTIONS"],
  })
);

const {
  PORT = 4000,
  AWS_REGION,
  AWS_ACCESS_KEY_ID,
  AWS_SECRET_ACCESS_KEY,
  S3_BUCKET,
  UPLOAD_PREFIX = "uploads/",
  MAX_FILE_BYTES = "5000000",
} = process.env;

if (!AWS_REGION || !AWS_ACCESS_KEY_ID || !AWS_SECRET_ACCESS_KEY || !S3_BUCKET) {
  console.error("Missing required AWS env vars");
  process.exit(1);
}

const s3 = new S3Client({
  region: AWS_REGION,
  credentials: {
    accessKeyId: AWS_ACCESS_KEY_ID,
    secretAccessKey: AWS_SECRET_ACCESS_KEY,
  },
});

app.post("/presign", async (req, res) => {
  try {
    const { participantId, studyId, taskId = "unknown", filename = "journeys.json", contentType = "application/json" } = req.body || {};
    if (!participantId) {
      return res.status(400).json({ error: "participantId required" });
    }
    const isV2 = String(taskId).startsWith("v2/");
    if (isV2) {
      const validParticipant = /^[a-z0-9](?:[a-z0-9-]{0,38}[a-z0-9])?$/.test(String(participantId));
      const validTaskId = /^v2\/[a-z0-9](?:[a-z0-9-]{0,38}[a-z0-9])?\/internal\/task-[A-Za-z0-9-]{8,80}$/.test(String(taskId));
      if (!validParticipant || !validTaskId || studyId !== "internal") {
        return res.status(400).json({ error: "Invalid v2 participant or task identifier" });
      }
      if (filename !== "long_task.json" || contentType !== "application/json") {
        return res.status(400).json({ error: "Invalid v2 upload type" });
      }
    }
    // Apollo PC bundles — keep in sync with lambda_presign.js.
    const isPC = String(taskId).startsWith("pc/");
    if (isPC) {
      const validParticipant = /^[a-z0-9](?:[a-z0-9-]{0,38}[a-z0-9])?$/.test(String(participantId));
      const validTaskId = /^pc\/[a-z0-9](?:[a-z0-9-]{0,38}[a-z0-9])?\/internal\/bundle-[A-Za-z0-9-]{8,80}$/.test(String(taskId));
      const validFilename = /^(manifest|tasks|records_[a-z]{3,20}(_part[1-9][0-9]{0,2})?|review_task_[A-Za-z0-9_-]{1,120})\.json$/.test(String(filename));
      if (!validParticipant || !validTaskId || studyId !== "internal") {
        return res.status(400).json({ error: "Invalid pc participant or bundle identifier" });
      }
      if (!validFilename || contentType !== "application/json") {
        return res.status(400).json({ error: "Invalid pc upload type" });
      }
    }
    // Mirror lambda_presign.js key layout so dev uploads match prod.
    const key = `${UPLOAD_PREFIX}${participantId}/${taskId}/${Date.now()}_${filename}`;
    const presign = await createPresignedPost(s3, {
      Bucket: S3_BUCKET,
      Key: key,
      Conditions: [
        ["content-length-range", 0, Number(MAX_FILE_BYTES)],
        ["eq", "$Content-Type", contentType],
        ["eq", "$x-amz-server-side-encryption", "AES256"],
      ],
      Fields: {
        "Content-Type": contentType,
        "x-amz-server-side-encryption": "AES256",
        "x-amz-meta-participant": participantId,
        "x-amz-meta-study": studyId || "unknown",
        "x-amz-meta-task": taskId,
      },
      Expires: 600,
    });
    return res.json({ url: presign.url, fields: presign.fields, key });
  } catch (err) {
    console.error("Presign error", err);
    return res.status(500).json({ error: "failed to presign", detail: err.message || String(err) });
  }
});

app.listen(PORT, () => {
  console.log(`Presign API listening on ${PORT}`);
});
