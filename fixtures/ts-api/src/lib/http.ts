export interface Pokemon {
  name: string;
  type: string;
  power: number;
}

export class HttpError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}

export function decodePokemonJSON(body: unknown): Pokemon {
  if (typeof body !== 'object' || body === null) {
    throw new HttpError(400, 'body must be an object');
  }
  const p = body as Partial<Pokemon>;
  if (!p.name) {
    throw new HttpError(400, 'pokemon name must not be empty');
  }
  return { name: p.name, type: p.type ?? 'unknown', power: p.power ?? 0 };
}

export function respondWithError(err: unknown): { status: number; body: unknown } {
  if (err instanceof HttpError) {
    return { status: err.status, body: { error: err.message } };
  }
  return { status: 500, body: { error: 'internal error' } };
}

export function respondWithJSON(status: number, body: unknown): { status: number; body: unknown } {
  return { status, body };
}
