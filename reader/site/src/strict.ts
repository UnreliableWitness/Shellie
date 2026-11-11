import { z } from 'zod';

// The site's content policy allows no `eval`. Zod tries one to see whether it may compile its parsers, and the
// browser reports the try as a violation; told not to, before the shared schemas are made, it does not try.
z.config({ jitless: true });
