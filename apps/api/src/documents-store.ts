import { GetObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { apiClientOptions, type ApiDocumentsStorageConfig } from "@job-to-invoice/config";

export const PRESIGN_EXPIRES_SECONDS = 5 * 60;

export type DocumentsDownloadStore = {
  presignGet: (key: string, expiresIn?: number) => Promise<string>;
};

export function createDocumentsDownloadStore(config: ApiDocumentsStorageConfig): DocumentsDownloadStore {
  const client = new S3Client(apiClientOptions(config));
  return {
    async presignGet(key, expiresIn = PRESIGN_EXPIRES_SECONDS) {
      const bounded = Math.max(1, Math.min(expiresIn, 24 * 60 * 60));
      return getSignedUrl(client, new GetObjectCommand({ Bucket: config.bucket, Key: key }), {
        expiresIn: bounded,
      });
    },
  };
}
