// Sign one trajectory screenshot for viewing.
//
// The runs hold ~13,000 frames and about a gigabyte, so they stay in S3 and are
// signed per request rather than bundled into the deployment. The key is
// validated against the trajectory prefix before it is signed: without that, a
// caller could name any object in the bucket and have this hand back a URL for
// it.
import { S3Client, GetObjectCommand } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";

const BUCKET = process.env.SHOWCASE_BUCKET || "journeys-prolific";
const ALLOWED = /^v2-review\/trajectory-runs\/[A-Za-z0-9_-]+\/[a-f0-9]{16,40}\/screens\/[0-9]{1,6}\.(png|jpg|jpeg|webp)$/;

const s3 = new S3Client({
  region: process.env.AWS_REGION || "us-east-1",
  credentials: process.env.SHOWCASE_AWS_ACCESS_KEY_ID
    ? {
        accessKeyId: process.env.SHOWCASE_AWS_ACCESS_KEY_ID,
        secretAccessKey: process.env.SHOWCASE_AWS_SECRET_ACCESS_KEY,
      }
    : undefined,
});

export default async function handler(request, response) {
  const key = String(request.query.key || "");
  if (!ALLOWED.test(key)) {
    return response.status(400).json({ error: "not a trajectory screenshot key" });
  }
  try {
    const url = await getSignedUrl(s3, new GetObjectCommand({ Bucket: BUCKET, Key: key }), {
      expiresIn: 3600,
    });
    response.setHeader("Cache-Control", "private, max-age=1800");
    return response.redirect(302, url);
  } catch (error) {
    return response.status(502).json({ error: "could not sign the screenshot" });
  }
}
