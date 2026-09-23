import { DeleteObjectCommand, GetObjectCommand, PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { workerClientOptions, type WorkerDocumentsStorageConfig } from "@job-to-invoice/config";

export type DocumentsObjectStore = {
  putObject: (input: { key: string; body: Buffer; contentType: string }) => Promise<void>;
  getObject?: (key: string) => Promise<Buffer | undefined>;
  deleteObject?: (key: string) => Promise<void>;
};

export function privatePutObjectInput(input: {
  bucket: string;
  key: string;
  body: Buffer;
  contentType: string;
}): {
  Bucket: string;
  Key: string;
  Body: Buffer;
  ContentType: string;
} {
  return {
    Bucket: input.bucket,
    Key: input.key,
    Body: input.body,
    ContentType: input.contentType,
  };
}

export function createDocumentsObjectStore(config: WorkerDocumentsStorageConfig): DocumentsObjectStore {
  const client = new S3Client(workerClientOptions(config));
  return {
    async putObject({ key, body, contentType }) {
      await client.send(
        new PutObjectCommand(
          privatePutObjectInput({
            bucket: config.bucket,
            key,
            body,
            contentType,
          }),
        ),
      );
    },
    async getObject(key) {
      try {
        const result = await client.send(new GetObjectCommand({ Bucket: config.bucket, Key: key }));
        const bytes = await result.Body?.transformToByteArray();
        return bytes ? Buffer.from(bytes) : undefined;
      } catch {
        return undefined;
      }
    },
    async deleteObject(key) {
      await client.send(new DeleteObjectCommand({ Bucket: config.bucket, Key: key }));
    },
  };
}
