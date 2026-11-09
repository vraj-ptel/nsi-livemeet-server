import type { NextFunction, Request, RequestHandler, Response } from "express";
import type { ParamsDictionary } from "express-serve-static-core";

/** Express 4 does not catch rejected promises; pass them to the error handler. */
export function asyncRoute<P = ParamsDictionary>(
  fn: (req: Request<P>, res: Response, next: NextFunction) => Promise<unknown>
): RequestHandler<P> {
  return (req, res, next) => {
    fn(req, res, next).catch(next);
  };
}
