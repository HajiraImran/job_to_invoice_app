import { GetObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { apiClientOptions, type DocumentsStorageConfig } from "@job-to-invoice/config";

export const PRESIGN_EXPIRES_SECONDS = 5 * 60;

export type DocumentsDownloadStore = {
  presignGet: (key: string) => Promise<string>;
};

export function createDocumentsDownloadStore(config: DocumentsStorageConfig): DocumentsDownloadStore {
  const client = new S3Client(apiClientOptions(config));
  return {
    async presignGet(key) {
      return getSignedUrl(client, new GetObjectCommand({ Bucket: config.bucket, Key: key }), {
        expiresIn: PRESIGN_EXPIRES_SECONDS,
      });
    },
  };
}
