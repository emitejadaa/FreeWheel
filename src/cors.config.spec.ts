import { createCorsOptions, parseCorsOrigins } from './cors.config';

describe('CORS config', () => {
  it('parses frontend and comma-separated origins without duplicates or trailing slashes', () => {
    expect(
      parseCorsOrigins({
        NODE_ENV: 'production',
        FRONTEND_URL: 'https://freewheel-5a.vercel.app/',
        CORS_ORIGINS: 'https://preview-a.vercel.app, https://preview-b.vercel.app/',
      }),
    ).toEqual([
      'https://freewheel-5a.vercel.app',
      'https://preview-a.vercel.app',
      'https://preview-b.vercel.app',
    ]);
  });

  it('allows configured origins and denies unknown origins without returning an error', () => {
    const options = createCorsOptions(['https://freewheel-5a.vercel.app']);
    const callback = jest.fn();

    if (typeof options.origin !== 'function') {
      throw new Error('Expected CORS origin option to be a function.');
    }

    options.origin('https://freewheel-5a.vercel.app/', callback);
    options.origin('https://unknown.example.com', callback);

    expect(callback).toHaveBeenNthCalledWith(1, null, true);
    expect(callback).toHaveBeenNthCalledWith(2, null, false);
  });
});
