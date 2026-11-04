import dotenv from 'dotenv';
dotenv.config({ quiet: true });
import mongoose from 'mongoose';
import { sendDiagnosticReportIfDue, sendDiagnosticTestEmail } from '../utils/diagnosticDailyReport';

async function main(): Promise<void> {
  if (process.argv.includes('--test')) {
    await sendDiagnosticTestEmail();
    console.log('Diagnostic test email accepted by SMTP. Recipient: 12345kolt@gmail.com');
    return;
  }
  const uri = process.env.MONGO_DB || process.env.MONGODB_URI || process.env.MONGO_URI;
  if (!uri) throw new Error('mongo_uri_missing');
  await mongoose.connect(uri);
  try { console.log(JSON.stringify({ sent: await sendDiagnosticReportIfDue(), schedule: '21:00 Europe/Moscow' })); }
  finally { await mongoose.disconnect(); }
}
void main().catch(error => {
  // Never print SMTP response bodies or environment values.
  console.error('Diagnostic report failed', { code: String(error?.code || 'REPORT_FAILED'), responseCode: error?.responseCode });
  process.exitCode = 1;
});
