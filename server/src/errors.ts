export class ApiError extends Error {
  constructor(public status: number, public code: string, message: string) {
    super(message);
    this.name = 'ApiError';
  }
}

export function publicError(error: unknown): ApiError {
  if (error instanceof ApiError) return error;
  return new ApiError(502, 'SOURCE_UNAVAILABLE', 'The source could not be reached. Please check the link and try again.');
}
