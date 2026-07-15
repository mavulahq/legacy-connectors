export interface BatchValidationError {
  record: number;
  field: string;
  code: string;
}

export interface BatchValidationReport {
  contract_id: string;
  accepted: boolean;
  export_id?: string;
  record_count: number;
  total_amount_minor: string;
  content_sha256?: string;
  errors: BatchValidationError[];
}
