import { PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { workerClientOptions, type DocumentsStorageConfig } from "@job-to-invoice/config";

export type DocumentsObjectStore = {
  putObject: (input: { key: string; body: Buffer; contentType: string }) => Promise<void>;
};

export function createDocumentsObjectStore(config: DocumentsStorageConfig): DocumentsObjectStore {
  const client = new S3Client(workerClientOptions(config));
  return {
    async putObject({ key, body, contentType }) {
      await client.send(
        new PutObjectCommand({
          Bucket: config.bucket,
          Key: key,
          Body: body,
          ContentType: contentType,
        }),
      );
    },
  };
}
