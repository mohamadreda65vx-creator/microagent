export class AppError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
    public readonly details?: unknown,
  ) {
    super(message);
    this.name = 'AppError';
  }
}

export const badRequest = (message: string, code = 'bad_request', details?: unknown) => new AppError(400, code, message, details);
export const unauthorized = (message = 'Authentication required', code = 'unauthorized') => new AppError(401, code, message);
export const forbidden = (message = 'You do not have permission to do this', code = 'forbidden') => new AppError(403, code, message);
export const notFound = (message = 'Not found', code = 'not_found') => new AppError(404, code, message);
export const conflict = (message: string, code = 'conflict') => new AppError(409, code, message);

/** Postgres error helpers */
export function pgCode(err: unknown): string | undefined {
  return typeof err === 'object' && err !== null && 'code' in err ? String((err as { code: unknown }).code) : undefined;
}
export function pgConstraint(err: unknown): string | undefined {
  return typeof err === 'object' && err !== null && 'constraint' in err ? String((err as { constraint: unknown }).constraint) : undefined;
}
