/**
 * Thin S3 wrapper.
 * - putObject for chunk + merged uploads.
 * - getSignedUrl for recruiter video playback.
 * - We use Buffer bodies (chunks are small — 5s of webm). For large merged files
 *   we keep streams via fs.createReadStream in the worker.
 */
const {
  S3Client,
  PutObjectCommand,
  GetObjectCommand,
  DeleteObjectCommand,
  ListObjectsV2Command
} = require('@aws-sdk/client-s3');
const { getSignedUrl } = require('@aws-sdk/s3-request-presigner');

const region = process.env.AWS_REGION || 'ap-south-1';
const bucket = process.env.AWS_S3_BUCKET;

const s3 = new S3Client({
  region,
  credentials:
    process.env.AWS_ACCESS_KEY_ID && process.env.AWS_SECRET_ACCESS_KEY
      ? {
          accessKeyId: process.env.AWS_ACCESS_KEY_ID,
          secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY
        }
      : undefined
});

async function putObject({ key, body, contentType }) {
  if (!bucket) throw new Error('AWS_S3_BUCKET is not configured');
  await s3.send(
    new PutObjectCommand({
      Bucket: bucket,
      Key: key,
      Body: body,
      ContentType: contentType || 'application/octet-stream'
    })
  );
  return { bucket, key };
}

async function getObjectStream(key) {
  const out = await s3.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
  return out.Body; // Readable
}

async function deleteObject(key) {
  await s3.send(new DeleteObjectCommand({ Bucket: bucket, Key: key }));
}

async function listObjects(prefix) {
  const out = await s3.send(new ListObjectsV2Command({ Bucket: bucket, Prefix: prefix }));
  return out.Contents || [];
}

async function presignGet(key, expiresIn) {
  return getSignedUrl(s3, new GetObjectCommand({ Bucket: bucket, Key: key }), {
    expiresIn: expiresIn || Number(process.env.PRESIGN_TTL_SECONDS) || 3600
  });
}

module.exports = { s3, bucket, putObject, getObjectStream, deleteObject, listObjects, presignGet };
