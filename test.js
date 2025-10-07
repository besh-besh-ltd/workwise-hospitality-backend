// test.js
import { PutObjectCommand } from "@aws-sdk/client-s3";
import s3Client from "./app/config/s3config.js";
import fs from "fs";
import dotenv from "dotenv";

dotenv.config();

export const uploadToS3 = async (filePath, fileName) => {
  try {
    console.log('📁 Starting upload process...');
    
    // Check file exists
    if (!fs.existsSync(filePath)) {
      throw new Error(`File not found: ${filePath}`);
    }

    console.log('✅ File found, reading file...');
    const fileBuffer = fs.readFileSync(filePath);

    const uploadParams = {
      Bucket: process.env.AWS_S3_BUCKET,
      Key: `purchase-order/${fileName}`,
      Body: fileBuffer,
      ContentType: "application/pdf",
    };

    console.log('🚀 Uploading to S3...');
    console.log('Bucket:', process.env.AWS_S3_BUCKET);
    console.log('Key:', `purchase-order/${fileName}`);
    
    const command = new PutObjectCommand(uploadParams);
    const response = await s3Client.send(command);

    console.log("✅ Upload success. ETag:", response.ETag);
    
    const url = `https://${process.env.AWS_S3_BUCKET}.s3.${process.env.AWS_REGION}.amazonaws.com/purchase-order/${fileName}`;
    
    return {
      ok: true,
      url: url,
      etag: response.ETag
    };
  } catch (err) {
    console.error("❌ Upload error details:");
    console.error("Error name:", err.name);
    console.error("Error message:", err.message);
    console.error("Error code:", err.code);
    
    if (err.$metadata) {
      console.error("Request ID:", err.$metadata.requestId);
      console.error("HTTP Status:", err.$metadata.httpStatusCode);
    }
    
    return { 
      ok: false, 
      error: err.message 
    };
  }
};

// Test the function
const testUpload = async () => {
  console.log('🧪 Starting upload test...');
  const result = await uploadToS3("./ABC.pdf", "test-upload.pdf");
  console.log("Final result:", result);
};

testUpload();