# AI Interview — AWS infrastructure

This folder provisions the **SQS + Lambda** half of the queue-driver
abstraction. The dev default is still BullMQ + Upstash Redis; this lights up
only when you set `QUEUE_DRIVER=sqs` on the API server.

## What gets created

- **SQS queue** `ai-interview-processing-<env>` — the work queue.
- **SQS DLQ** `ai-interview-processing-dlq-<env>` — failed messages after 5 retries.
- **Lambda function** `ai-interview-processing-<env>` — runs FFmpeg merge +
  Groq scoring. Same code as the BullMQ worker (`server/workers/handler.js`),
  just wrapped by `server/lambda/processor/index.js`.
- **IAM role** — least-privilege: SQS receive/delete on the queue + S3 read/write
  on your bucket.

## Prereqs

- AWS CLI configured (`aws configure`)
- [AWS SAM CLI](https://docs.aws.amazon.com/serverless-application-model/latest/developerguide/install-sam-cli.html)
- An IAM principal with rights to create CloudFormation stacks + the resources above
- A public **FFmpeg Lambda layer** ARN for `nodejs20.x` (recommended). The repo
  https://github.com/serverlesspub/ffmpeg-aws-lambda-layer publishes ARNs per
  region. Example for `ap-south-1`:
  ```
  arn:aws:lambda:ap-south-1:145266761615:layer:ffmpeg:4
  ```
  (Check the repo for the latest version in your region.) If you bake ffmpeg
  into a custom image instead, leave `FFmpegLayerArn` empty.

## Build the Lambda zip

The Lambda needs the worker code + a slim `node_modules`. Run this every time
`workers/handler.js`, `models/`, `utils/`, or `config/db.js` change:

```bash
bash server/lambda/build.sh
# → dist/lambda.zip
```

## Deploy

First time — interactive, creates `samconfig.toml` you can reuse:

```bash
cd infra
sam build              # uses the CodeUri in template.yaml (../dist/lambda.zip)
sam deploy --guided
```

Answer the prompts:
- Stack name: `ai-interview-dev` (or `-prod`)
- AWS region: `ap-south-1`
- `StackEnv`: `dev` / `staging` / `prod`
- `MongoDBUri`: your Atlas URI
- `GroqApiKey`: `gsk_...`
- `AwsS3Bucket`: e.g. `ai-interview-chunks`
- `FFmpegLayerArn`: the layer ARN from the prereqs

Subsequent deploys:

```bash
bash ../server/lambda/build.sh
sam deploy
```

The stack outputs `ProcessingQueueUrl` — copy it into the API server's `.env`:

```env
QUEUE_DRIVER=sqs
AWS_SQS_QUEUE_URL=https://sqs.ap-south-1.amazonaws.com/123456789012/ai-interview-processing-dev
AWS_REGION=ap-south-1
AWS_ACCESS_KEY_ID=...
AWS_SECRET_ACCESS_KEY=...
```

Restart the API server (`npm run dev:server`). Stop the BullMQ worker — you
don't need it anymore when `QUEUE_DRIVER=sqs`. Complete a test interview and
watch the Lambda logs:

```bash
sam logs -n ProcessingFunction --stack-name ai-interview-dev --tail
```

You should see the familiar `[BUG4][WORKER]` lines exactly as they appear in
the BullMQ worker.

## Switching back to BullMQ

Just change `.env`:

```env
QUEUE_DRIVER=bullmq
REDIS_URL=rediss://...upstash.io:6380
```

…and start the BullMQ worker again (`npm run worker`). No code change required.

## Inspect the DLQ

After 5 failed attempts a message ends up in the DLQ. Look at it:

```bash
aws sqs receive-message \
  --queue-url $(aws cloudformation describe-stacks \
    --stack-name ai-interview-dev \
    --query 'Stacks[0].Outputs[?OutputKey==`ProcessingDLQUrl`].OutputValue' \
    --output text) \
  --max-number-of-messages 10
```

The message body is `{"sessionId":"..."}`. The session itself will be in
`status: 'failed'` in Mongo (the handler writes that on its way out).

## Tear down

```bash
cd infra
sam delete --stack-name ai-interview-dev
```
