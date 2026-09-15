import { PutObjectCommand, S3Client } from "@aws-sdk/client-s3";

export type DocumentsObjectStore = {
  putObject: (input: { key: string; body: Buffer; contentType: string }) => Promise<void>;
};

export function createR2DocumentsStore(input: {
  accountId: string;
  bucket: string;
  accessKeyId: string;
  secretAccessKey: string;
}): DocumentsObjectStore {
  const client = new S3Client({
    region: "auto",
    endpoint: `https://${input.accountId}.r2.cloudflarestorage.com`,
    credentials: {
      accessKeyId: input.accessKeyId,
      secretAccessKey: input.secretAccessKey,
    },
  });
  return {
    async putObject({ key, body, contentType }) {
      await client.send(
        new PutObjectCommand({
          Bucket: input.bucket,
          Key: key,
          Body: body,
          ContentType: contentType,
        }),
      );
    },
  };
}
