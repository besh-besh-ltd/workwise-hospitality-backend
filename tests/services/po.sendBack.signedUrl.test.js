// Signed links to send-back attachments (client ticket T3).
// ----------------------------------------------------------------------------
// The thread links to evidence with a presigned GET that expires, signed by
// app/services/po/s3SignedUrl.js (there is no presigner dependency). Pinned to
// AWS's own published example of a presigned URL, so a signing mistake fails
// here rather than as a 403 in someone's browser.
//
// Pure computation: no network, no database.

import { describe, it, expect } from "@jest/globals";
import { parseS3ObjectUrl, presignS3GetUrl, signedFileUrl } from "../../app/services/po/s3SignedUrl.js";

describe("presigned S3 links", () => {
  it("matches AWS's published SigV4 query-string example", () => {
    // docs.aws.amazon.com/AmazonS3/latest/API/sigv4-query-string-auth.html
    const url = presignS3GetUrl(
      { bucket: "examplebucket", region: "us-east-1", key: "test.txt", host: "examplebucket.s3.amazonaws.com" },
      { accessKeyId: "AKIAIOSFODNN7EXAMPLE", secretAccessKey: "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY" },
      { expiresIn: 86400, now: new Date("2013-05-24T00:00:00Z") }
    );
    expect(url).toBe(
      "https://examplebucket.s3.amazonaws.com/test.txt" +
        "?X-Amz-Algorithm=AWS4-HMAC-SHA256" +
        "&X-Amz-Credential=AKIAIOSFODNN7EXAMPLE%2F20130524%2Fus-east-1%2Fs3%2Faws4_request" +
        "&X-Amz-Date=20130524T000000Z&X-Amz-Expires=86400&X-Amz-SignedHeaders=host" +
        "&X-Amz-Signature=aeeed9bbccd4d02ee5c0109b86d86835f995330da4c265957d157751f604d404"
    );
  });

  it("reads bucket, region and key from the URL an upload returns", () => {
    expect(parseS3ObjectUrl("https://my-bucket.s3.ap-south-1.amazonaws.com/purchase-order/send-back/1-a%20b.pdf")).toEqual({
      bucket: "my-bucket", region: "ap-south-1", key: "purchase-order/send-back/1-a b.pdf",
      host: "my-bucket.s3.ap-south-1.amazonaws.com",
    });
    expect(parseS3ObjectUrl("https://example.com/file.pdf")).toBeNull();
    expect(parseS3ObjectUrl("not a url")).toBeNull();
  });

  it("signs only our own bucket and returns anything else as stored", () => {
    const bucket = process.env.AWS_S3_BUCKET;
    expect(bucket).toBeTruthy();
    const ours = `https://${bucket}.s3.ap-south-1.amazonaws.com/purchase-order/send-back/x.png`;
    expect(signedFileUrl(ours)).toMatch(new RegExp(`^${ours.replace(/[.?]/g, "\\$&")}\\?X-Amz-Algorithm=AWS4-HMAC-SHA256&.*X-Amz-Signature=[0-9a-f]{64}$`));
    const theirs = "https://someone-else.s3.ap-south-1.amazonaws.com/x.png";
    expect(signedFileUrl(theirs)).toBe(theirs);
    expect(signedFileUrl("https://example.com/x.png")).toBe("https://example.com/x.png");
  });
});
