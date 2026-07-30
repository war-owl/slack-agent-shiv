/** The stable subset of a Slack file object that a Job needs. */
export interface MentionFile {
  id: string;
  name: string;
  mimetype: string;
  size: number;
  privateDownloadUrl: string;
}

/** One attachment after Slack's bytes have landed inside the Job workspace. */
export interface IngestedFile {
  name: string;
  path: string;
  mimetype: string;
  size: number;
}
