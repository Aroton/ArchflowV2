#!/usr/bin/env node

const chunks = [];
for await (const chunk of process.stdin) chunks.push(Buffer.from(chunk));
process.stdout.write(Buffer.concat(chunks));
