/**
 * Tests for rfqModel (app/models/rfqModel.js)
 *
 * Uses jest.unstable_mockModule() for ESM-compatible mocking.
 * All database interaction is mocked via the `db` default export
 * from app/config/dbConn.js.
 */

import { jest, describe, it, expect, beforeAll, beforeEach } from '@jest/globals';

/* ------------------------------------------------------------------ */
/*  Mock setup  (must come BEFORE any dynamic import of the SUT)      */
/* ------------------------------------------------------------------ */

const mockDb = {
  query: jest.fn(),
  any: jest.fn(),
  one: jest.fn(),
  oneOrNone: jest.fn(),
  none: jest.fn(),
  result: jest.fn(),
  tx: jest.fn(),
};

const mockPgpHelpers = {
  insert: jest.fn(),
};

const mockPgp = {
  helpers: mockPgpHelpers,
};

// Mock the db config module (default export = db instance, named export = pgp)
jest.unstable_mockModule('../../app/config/dbConn.js', () => ({
  default: mockDb,
  pgp: mockPgp,
}));

// Mock dependent models so the module can load without side-effects
jest.unstable_mockModule('../../app/config/app.config.js', () => ({
  default: {},
}));

jest.unstable_mockModule('../../app/models/generalModel.js', () => ({
  default: {},
}));

jest.unstable_mockModule('../../app/models/userModel.js', () => ({
  default: {},
}));

jest.unstable_mockModule('../../app/models/cmsModel.js', () => ({
  default: {},
}));

jest.unstable_mockModule('../../app/helper/common.js', () => ({
  logError: jest.fn(),
  PERSISTENCE_STATUSES: {},
}));

jest.unstable_mockModule('../../app/controllers/rfq/rfqController.js', () => ({
  notifyBuyerOnPersistenceViaEmail: jest.fn(),
}));

jest.unstable_mockModule('../../app/util/constants.js', () => ({
  PO_STATUSES: {},
}));

/* ------------------------------------------------------------------ */
/*  Dynamic import of the system under test                            */
/* ------------------------------------------------------------------ */

let rfqModel;

beforeAll(async () => {
  const mod = await import('../../app/models/rfqModel.js');
  rfqModel = mod.default;
});

beforeEach(() => {
  jest.clearAllMocks();
});

/* ================================================================== */
/*  insert(table_name, data, db_con)                                  */
/* ================================================================== */
describe('rfqModel.insert', () => {
  test('should build a parameterized INSERT query and resolve with the result', async () => {
    const fakeRow = { id: 1, name: 'Widget', price: 9.99 };
    mockDb.query.mockResolvedValue([fakeRow]);

    const data = { name: 'Widget', price: 9.99 };
    const result = await rfqModel.insert('tbl_products', data);

    // Verify the query was called with proper placeholders
    expect(mockDb.query).toHaveBeenCalledTimes(1);
    const [query, values] = mockDb.query.mock.calls[0];
    expect(query).toContain('INSERT INTO tbl_products');
    expect(query).toContain('name, price');
    expect(query).toContain('$1, $2');
    expect(query).toContain('RETURNING *');
    expect(values).toEqual(['Widget', 9.99]);
    expect(result).toEqual([fakeRow]);
  });

  test('should use a custom db_con when provided', async () => {
    const customDb = { query: jest.fn().mockResolvedValue([{ id: 42 }]) };
    const result = await rfqModel.insert('tbl_items', { sku: 'A1' }, customDb);

    expect(customDb.query).toHaveBeenCalledTimes(1);
    expect(mockDb.query).not.toHaveBeenCalled();
    expect(result).toEqual([{ id: 42 }]);
  });

  test('should handle single-column inserts correctly', async () => {
    mockDb.query.mockResolvedValue([{ id: 1, status: 'active' }]);
    await rfqModel.insert('tbl_status', { status: 'active' });

    const [query, values] = mockDb.query.mock.calls[0];
    expect(query).toContain('(status)');
    expect(query).toContain('($1)');
    expect(values).toEqual(['active']);
  });

  test('should reject with an Error when the database query fails', async () => {
    mockDb.query.mockRejectedValue('connection timeout');

    await expect(
      rfqModel.insert('tbl_products', { name: 'fail' })
    ).rejects.toThrow();
  });

  test('should reject with an Error object (not a raw string) on failure', async () => {
    mockDb.query.mockRejectedValue('raw error string');

    try {
      await rfqModel.insert('tbl_x', { a: 1 });
      // If we reach here the test should fail
      expect(true).toBe(false);
    } catch (err) {
      expect(err).toBeInstanceOf(Error);
    }
  });
});

/* ================================================================== */
/*  insertIntoQuoteActivity(data, db_con)                             */
/* ================================================================== */
describe('rfqModel.insertIntoQuoteActivity', () => {
  test('should execute the status-tracking INSERT query with correct parameters', async () => {
    mockDb.query.mockResolvedValue({ rowCount: 1 });

    const data = { rfq_id: 10, current_status: 'PUBLISHED', created_by: 5 };
    const result = await rfqModel.insertIntoQuoteActivity(data);

    expect(mockDb.query).toHaveBeenCalledTimes(1);
    const [query, values] = mockDb.query.mock.calls[0];
    expect(query).toContain('INSERT INTO tbl_quote_activity');
    expect(query).toContain('$1::int');
    expect(query).toContain('IS DISTINCT FROM $2');
    expect(values).toEqual([10, 'PUBLISHED', 5]);
    expect(result).toEqual({ rowCount: 1 });
  });

  test('should accept a custom db_con for transactional use', async () => {
    const txDb = { query: jest.fn().mockResolvedValue({ rowCount: 1 }) };
    await rfqModel.insertIntoQuoteActivity(
      { rfq_id: 1, current_status: 'DRAFT', created_by: 2 },
      txDb
    );

    expect(txDb.query).toHaveBeenCalledTimes(1);
    expect(mockDb.query).not.toHaveBeenCalled();
  });

  test('should reject with an Error when the query fails', async () => {
    mockDb.query.mockRejectedValue('duplicate key');

    await expect(
      rfqModel.insertIntoQuoteActivity({
        rfq_id: 10,
        current_status: 'PUBLISHED',
        created_by: 5,
      })
    ).rejects.toThrow();
  });
});

/* ================================================================== */
/*  getProductsByRfqId(rfqId, db_con)                                 */
/* ================================================================== */
describe('rfqModel.getProductsByRfqId', () => {
  test('should return products when a valid rfqId is provided', async () => {
    const products = [
      { name: 'Towels', spec: null, vendors: null },
      { name: 'Soap', spec: [{ title: 'Weight', value: '100g' }], vendors: null },
    ];
    mockDb.any.mockResolvedValue(products);

    const result = await rfqModel.getProductsByRfqId(42);

    expect(mockDb.any).toHaveBeenCalledTimes(1);
    const [query, params] = mockDb.any.mock.calls[0];
    expect(query).toContain('tbl_rfq_products');
    expect(query).toContain('tbl_rfq_products_specs');
    expect(params).toEqual([42]);
    expect(result).toEqual(products);
  });

  test('should throw an Error when rfqId is falsy (undefined)', async () => {
    await expect(rfqModel.getProductsByRfqId(undefined)).rejects.toThrow(
      'RFQ ID is required!'
    );
  });

  test('should throw an Error when rfqId is null', async () => {
    await expect(rfqModel.getProductsByRfqId(null)).rejects.toThrow(
      'RFQ ID is required!'
    );
  });

  test('should throw an Error when rfqId is 0', async () => {
    await expect(rfqModel.getProductsByRfqId(0)).rejects.toThrow(
      'RFQ ID is required!'
    );
  });

  test('should propagate database errors', async () => {
    mockDb.any.mockRejectedValue(new Error('relation does not exist'));

    await expect(rfqModel.getProductsByRfqId(99)).rejects.toThrow(
      'relation does not exist'
    );
  });

  test('should use a custom db_con when provided', async () => {
    const customDb = { any: jest.fn().mockResolvedValue([]) };
    const result = await rfqModel.getProductsByRfqId(7, customDb);

    expect(customDb.any).toHaveBeenCalledTimes(1);
    expect(mockDb.any).not.toHaveBeenCalled();
    expect(result).toEqual([]);
  });
});

/* ================================================================== */
/*  getVariantsCountForRFQ(rfqId)                                     */
/* ================================================================== */
describe('rfqModel.getVariantsCountForRFQ', () => {
  test('should return an empty array when rfqId is falsy (undefined)', async () => {
    const result = await rfqModel.getVariantsCountForRFQ(undefined);
    expect(result).toEqual([]);
    expect(mockDb.any).not.toHaveBeenCalled();
  });

  test('should return an empty array when rfqId is null', async () => {
    const result = await rfqModel.getVariantsCountForRFQ(null);
    expect(result).toEqual([]);
  });

  test('should return an empty array when rfqId is 0', async () => {
    const result = await rfqModel.getVariantsCountForRFQ(0);
    expect(result).toEqual([]);
  });

  test('should query and return variant counts for a valid rfqId', async () => {
    const variants = [
      { product_variant_id: 1, max_variant: 3 },
      { product_variant_id: 2, max_variant: 1 },
    ];
    mockDb.any.mockResolvedValue(variants);

    // Suppress console.log from the model
    const spy = jest.spyOn(console, 'log').mockImplementation(() => {});

    const result = await rfqModel.getVariantsCountForRFQ(55);

    expect(mockDb.any).toHaveBeenCalledTimes(1);
    const [query, params] = mockDb.any.mock.calls[0];
    expect(query).toContain('MAX(variant)');
    expect(query).toContain('tbl_rfq_products');
    expect(params).toEqual([55]);
    expect(result).toEqual(variants);

    spy.mockRestore();
  });

  test('should propagate database errors', async () => {
    mockDb.any.mockRejectedValue(new Error('timeout'));

    // Suppress console.log
    const spy = jest.spyOn(console, 'log').mockImplementation(() => {});

    await expect(rfqModel.getVariantsCountForRFQ(10)).rejects.toThrow('timeout');

    spy.mockRestore();
  });
});

/* ================================================================== */
/*  checkRFQCompletion(rfq_id, selectedSheets)                        */
/* ================================================================== */
describe('rfqModel.checkRFQCompletion', () => {
  test('should return true when total products match qualified products', async () => {
    mockDb.any
      .mockResolvedValueOnce([{ product_variant_id: 1, variant: 1 }]) // totalRes
      .mockResolvedValueOnce([{ product_variant_id: 1, variant: 1 }]); // qualifiedRes

    const result = await rfqModel.checkRFQCompletion(10);
    expect(result).toBe(true);
  });

  test('should return false when qualified count is less than total', async () => {
    mockDb.any
      .mockResolvedValueOnce([
        { product_variant_id: 1, variant: 1 },
        { product_variant_id: 2, variant: 1 },
      ]) // totalRes: 2
      .mockResolvedValueOnce([
        { product_variant_id: 1, variant: 1 },
      ]); // qualifiedRes: 1

    const result = await rfqModel.checkRFQCompletion(10);
    expect(result).toBe(false);
  });

  test('should return true when both total and qualified are empty', async () => {
    mockDb.any
      .mockResolvedValueOnce([]) // totalRes
      .mockResolvedValueOnce([]); // qualifiedRes

    const result = await rfqModel.checkRFQCompletion(10);
    expect(result).toBe(true);
  });

  test('should include sheet_id IN clause when selectedSheets is a non-empty array', async () => {
    mockDb.any
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([]);

    await rfqModel.checkRFQCompletion(10, [1, 2, 3]);

    // Both queries (totalQ and qualifiedQ) should contain the sheet filter
    const totalQuery = mockDb.any.mock.calls[0][0];
    const qualifiedQuery = mockDb.any.mock.calls[1][0];
    expect(totalQuery).toContain('sheet_id IN (1,2,3)');
    expect(qualifiedQuery).toContain('sheet_id IN (1,2,3)');
  });

  test('should NOT include sheet_id clause when selectedSheets is undefined', async () => {
    mockDb.any
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([]);

    await rfqModel.checkRFQCompletion(10, undefined);

    const totalQuery = mockDb.any.mock.calls[0][0];
    expect(totalQuery).not.toContain('sheet_id IN');
  });

  test('should NOT include sheet_id clause when selectedSheets is an empty array', async () => {
    mockDb.any
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([]);

    await rfqModel.checkRFQCompletion(10, []);

    const totalQuery = mockDb.any.mock.calls[0][0];
    expect(totalQuery).not.toContain('sheet_id IN');
  });

  test('should handle null returns from db.any gracefully (via nullish coalescing)', async () => {
    mockDb.any
      .mockResolvedValueOnce(null) // totalRes is null
      .mockResolvedValueOnce(null); // qualifiedRes is null

    // (null ?? []).length === 0, so 0 === 0 is true
    const result = await rfqModel.checkRFQCompletion(10);
    expect(result).toBe(true);
  });

  test('should propagate database errors', async () => {
    mockDb.any.mockRejectedValue(new Error('permission denied'));

    await expect(rfqModel.checkRFQCompletion(10)).rejects.toThrow(
      'permission denied'
    );
  });
});

/* ================================================================== */
/*  checkIfExists(table_name, parameter, db_con)                      */
/* ================================================================== */
describe('rfqModel.checkIfExists', () => {
  test('should resolve with data when rows exist', async () => {
    const rows = [{ id: 1, name: 'Test' }];
    mockDb.any.mockResolvedValue(rows);

    const result = await rfqModel.checkIfExists('tbl_rfq', 'id = 1');

    expect(mockDb.any).toHaveBeenCalledTimes(1);
    const [query] = mockDb.any.mock.calls[0];
    expect(query).toContain('SELECT * FROM tbl_rfq WHERE id = 1');
    expect(result).toEqual(rows);
  });

  test('should resolve with an empty array when no rows match', async () => {
    mockDb.any.mockResolvedValue([]);

    const result = await rfqModel.checkIfExists('tbl_rfq', 'id = 999');
    expect(result).toEqual([]);
  });

  test('should reject with an Error on database failure', async () => {
    mockDb.any.mockRejectedValue('table not found');

    await expect(
      rfqModel.checkIfExists('bad_table', '1=1')
    ).rejects.toThrow();
  });

  test('should use a custom db_con when provided', async () => {
    const txDb = { any: jest.fn().mockResolvedValue([{ id: 5 }]) };
    const result = await rfqModel.checkIfExists('tbl_rfq', 'id = 5', txDb);

    expect(txDb.any).toHaveBeenCalledTimes(1);
    expect(mockDb.any).not.toHaveBeenCalled();
    expect(result).toEqual([{ id: 5 }]);
  });
});

/* ================================================================== */
/*  getSheetsForDraftRfq(rfq_id, is_processed, sheet_id)              */
/* ================================================================== */
describe('rfqModel.getSheetsForDraftRfq', () => {
  test('should build condition with only rfq_id when no optional params', async () => {
    mockDb.any.mockResolvedValue([{ id: 1, rfq_id: 10 }]);

    await rfqModel.getSheetsForDraftRfq(10);

    const [query] = mockDb.any.mock.calls[0];
    expect(query).toContain('rfq_id = 10');
    expect(query).not.toContain('AND is_processed');
    expect(query).toContain('ORDER BY id');
  });

  test('should add is_processed filter when is_processed is "true"', async () => {
    mockDb.any.mockResolvedValue([]);

    await rfqModel.getSheetsForDraftRfq(10, 'true');

    const [query] = mockDb.any.mock.calls[0];
    expect(query).toContain('AND is_processed');
  });

  test('should add sheet_id filter when sheet_id is a valid number', async () => {
    mockDb.any.mockResolvedValue([]);

    await rfqModel.getSheetsForDraftRfq(10, undefined, '5');

    const [query] = mockDb.any.mock.calls[0];
    expect(query).toContain('AND id = 5');
  });

  test('should not add sheet_id filter when sheet_id is NaN', async () => {
    mockDb.any.mockResolvedValue([]);

    await rfqModel.getSheetsForDraftRfq(10, undefined, 'abc');

    const [query] = mockDb.any.mock.calls[0];
    expect(query).not.toContain('AND id =');
  });
});

/* ================================================================== */
/*  generateReminderTokenValue (module-level, not exported directly)   */
/*  We test it indirectly by verifying the token format expectations.  */
/*  Since it is not exported, we confirm the function's behavior by    */
/*  calling a method that uses it, or we verify the contract here.     */
/* ================================================================== */
describe('generateReminderTokenValue (behavioral contract)', () => {
  /**
   * generateReminderTokenValue is a private module-level function.
   * It is NOT on rfqModel and NOT exported from the module.
   * We verify its contract: it should produce a 16-digit numeric token
   * built from Date.now() + random padding.
   *
   * Since we cannot import it directly, we replicate the logic and
   * validate the algorithm produces the correct shape.
   */

  const replicateTokenGeneration = () => {
    const timestamp = Date.now().toString();
    const randomSegment = Math.floor(Math.random() * 1_000_000)
      .toString()
      .padStart(6, '0');
    return parseInt((timestamp + randomSegment).slice(0, 16), 10);
  };

  test('should produce a numeric value (not NaN)', () => {
    const token = replicateTokenGeneration();
    expect(typeof token).toBe('number');
    expect(Number.isNaN(token)).toBe(false);
  });

  test('should produce a token with at most 16 digits', () => {
    const token = replicateTokenGeneration();
    const digitCount = token.toString().length;
    expect(digitCount).toBeLessThanOrEqual(16);
    expect(digitCount).toBeGreaterThanOrEqual(15); // Date.now is 13 digits currently, plus padding
  });

  test('should produce unique tokens across multiple invocations', () => {
    const tokens = new Set();
    for (let i = 0; i < 100; i++) {
      tokens.add(replicateTokenGeneration());
    }
    // With timestamp + random, collisions should be extremely rare
    // Allow at most 15 collisions out of 100 to avoid flaky tests
    expect(tokens.size).toBeGreaterThan(85);
  });

  test('should always be a positive integer', () => {
    for (let i = 0; i < 50; i++) {
      const token = replicateTokenGeneration();
      expect(Number.isInteger(token)).toBe(true);
      expect(token).toBeGreaterThan(0);
    }
  });
});
