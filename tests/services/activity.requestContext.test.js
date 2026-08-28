/**
 * Request context — the ambient "who is doing this" that the activity trail
 * and the audit triggers both read.
 *
 * The backend threads the acting user explicitly through every layer
 * (`performed_by`, `changedBy`, `userId`). That works, but it means anything
 * wanting the actor at the bottom of the stack — a Postgres trigger, say —
 * cannot have it. AsyncLocalStorage gives the actor to code that was never
 * passed it, without touching 342 call sites.
 *
 * The actor is resolved from `req` on demand rather than captured when the
 * context opens. The context has to open before the router (that is the only
 * place a single mount covers every route), but authentication runs per-route
 * afterwards — so at open time there is no `req.user` yet. Reading it lazily
 * is what makes one global mount sufficient.
 */
import express from 'express';
import request from 'supertest';
import requestContext, { ACTOR_TYPES, resolveActor } from '../../app/middleware/requestContext.js';
import {
  getRequestContext,
  getActorUserId,
  updateRequestContext,
} from '../../app/util/requestContext.js';

const buildApp = (routeSetup) => {
  const app = express();
  app.use(express.json());
  app.use(requestContext);
  routeSetup(app);
  return app;
};

describe('request context', () => {
  it('is available to code that was never handed the request', async () => {
    // A model function, three layers down, with no access to `req`.
    const deepInsideTheStack = () => getRequestContext()?.requestId ?? null;

    const app = buildApp((a) =>
      a.get('/x', (req, res) => res.json({ requestId: deepInsideTheStack() }))
    );

    const res = await request(app).get('/x');
    expect(res.body.requestId).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('gives every request its own id', async () => {
    const app = buildApp((a) =>
      a.get('/x', (req, res) => res.json({ id: getRequestContext().requestId }))
    );

    const [a, b] = await Promise.all([request(app).get('/x'), request(app).get('/x')]);
    expect(a.body.id).not.toEqual(b.body.id);
  });

  it('sees a user authenticated after the context opened', async () => {
    // This is the ordering that matters: context mounts globally, passport
    // runs per-route afterwards. A context that snapshotted the actor at open
    // time would record nobody for every authenticated request in the app.
    const app = buildApp((a) =>
      a.get(
        '/x',
        (req, _res, next) => {
          req.user = { id: 467, name: 'Priya', user_type: 2 };
          next();
        },
        (req, res) => res.json({ actorUserId: getActorUserId() })
      )
    );

    const res = await request(app).get('/x');
    expect(res.body.actorUserId).toBe(467);
  });

  it('never reports the site-rep marker id as a real user', async () => {
    // auth.js uses id: -1 for a GRN token login. getActorUserId feeds the
    // Postgres audit trigger, so letting -1 through would stamp a user id
    // that does not exist onto every row that request touches.
    const app = buildApp((a) =>
      a.get(
        '/x',
        (req, _res, next) => {
          req.user = { id: -1, name: 'Ravi Kumar', is_token_user: true };
          next();
        },
        (req, res) => res.json({ actorUserId: getActorUserId() })
      )
    );

    const res = await request(app).get('/x');
    expect(res.body.actorUserId).toBeNull();
  });

  it('reports no actor outside a request rather than throwing', () => {
    expect(getRequestContext()).toBeNull();
    expect(getActorUserId()).toBeNull();
    expect(() => updateRequestContext({ anything: 1 })).not.toThrow();
  });

  it('carries values written mid-request', async () => {
    const app = buildApp((a) =>
      a.get(
        '/x',
        (req, _res, next) => {
          updateRequestContext({ hospitalityCompanyId: 5 });
          next();
        },
        (req, res) => res.json({ companyId: getRequestContext().hospitalityCompanyId })
      )
    );

    const res = await request(app).get('/x');
    expect(res.body.companyId).toBe(5);
  });
});

describe('actor resolution', () => {
  const actorOf = (req) => resolveActor(req);

  it('recognises a buyer or an admin as a person', () => {
    expect(actorOf({ user: { id: 467, name: 'Priya', user_type: 2 } })).toMatchObject({
      actorType: ACTOR_TYPES.USER,
      actorUserId: 467,
      actorLabel: 'Priya',
    });
    expect(actorOf({ user: { id: 12, name: 'Admin', user_type: 7 } })).toMatchObject({
      actorType: ACTOR_TYPES.USER,
    });
  });

  it('distinguishes a vendor, who is a counterparty and not staff', () => {
    expect(actorOf({ user: { id: 497, name: 'Surya Enterprises', user_type: 3 } })).toMatchObject({
      actorType: ACTOR_TYPES.VENDOR,
      actorUserId: 497,
    });
  });

  it('still calls a vendor a vendor when they arrive on an emailed link', () => {
    // vendorTokenOrJwt resolves a real vendor row but marks the session
    // unverified. The trail should not invent a separate kind of actor for it.
    expect(
      actorOf({ user: { id: 497, name: 'Surya', user_type: 3 }, is_verified: false })
    ).toMatchObject({ actorType: ACTOR_TYPES.VENDOR, actorUserId: 497 });
  });

  it('names the site representative behind a GRN token instead of calling it System', () => {
    // A real human recorded the goods receipt; they simply have no account.
    // `id: -1` is auth.js's marker and must never be written as an actor id.
    const req = {
      user: {
        id: -1,
        name: 'Ravi Kumar',
        email: 'ravi@site.example',
        is_token_user: true,
        tokenType: 'GRN',
      },
    };
    expect(actorOf(req)).toMatchObject({
      actorType: ACTOR_TYPES.GUEST_TOKEN,
      actorUserId: null,
      actorLabel: 'Ravi Kumar',
    });
  });

  it('attributes the scheduler and the AI webhook to the system, not to a person', () => {
    expect(actorOf({ isSchedulerRequest: true })).toMatchObject({
      actorType: ACTOR_TYPES.SYSTEM,
      actorUserId: null,
    });
    expect(actorOf({ isWebhookRequest: true })).toMatchObject({
      actorType: ACTOR_TYPES.SYSTEM,
    });
  });

  it('falls back to an anonymous actor for public routes', () => {
    expect(actorOf({})).toMatchObject({ actorType: ACTOR_TYPES.PUBLIC, actorUserId: null });
  });

  it('labels a nameless user by email, then by id, rather than leaving it blank', () => {
    expect(actorOf({ user: { id: 9, email: 'a@b.c', user_type: 2 } }).actorLabel).toBe('a@b.c');
    expect(actorOf({ user: { id: 9, user_type: 2 } }).actorLabel).toBe('User #9');
  });
});
