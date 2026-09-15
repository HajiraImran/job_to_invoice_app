import { GetObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";

export const PRESIGN_EXPIRES_SECONDS = 5 * 60;

export type DocumentsDownloadStore = {
  presignGet: (key: string) => Promise<string>;
};

export function createR2DownloadStore(input: {
  accountId: string;
  bucket: string;
  accessKeyId: string;
  secretAccessKey: string;
}): DocumentsDownloadStore {
  const client = new S3Client({
    region: "auto",
    endpoint: `https://${input.accountId}.r2.cloudflarestorage.com`,
    credentials: {
      accessKeyId: input.accessKeyId,
      secretAccessKey: input.secretAccessKey,
    },
  });
  return {
    async presignGet(key) {
      return getSignedUrl(client, new GetObjectCommand({ Bucket: input.bucket, Key: key }), {
        expiresIn: PRESIGN_EXPIRES_SECONDS,
      });
    },
  };
}
