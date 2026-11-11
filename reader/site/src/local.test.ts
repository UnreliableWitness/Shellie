import { describe, expect, it } from 'vitest';
import { b64url } from '../../../src/shared/reader';
import {
  forgetLocal,
  loadPlaces,
  loadSecret,
  prunePlaces,
  savePlace,
  SECRET_KEY,
  takeSecretFromAddress,
} from './local';
import { SECRET } from './testing';

describe('the secret in the address', () => {
  it('is stored and taken out of the address at once', () => {
    history.replaceState(null, '', `/#${b64url(SECRET)}`);
    expect(takeSecretFromAddress()).toEqual(SECRET);
    expect(window.location.hash).toBe('');
    expect(window.location.href).not.toContain(b64url(SECRET));
    expect(localStorage.getItem(SECRET_KEY)).toBe(b64url(SECRET));
    expect(loadSecret()).toEqual(SECRET);
  });

  it('leaves a fragment that is no secret alone', () => {
    history.replaceState(null, '', '/#cut-off-time');
    expect(takeSecretFromAddress()).toBeNull();
    expect(window.location.hash).toBe('#cut-off-time');
    expect(loadSecret()).toBeNull();
  });

  it('is gone, with the places, once the phone is forgotten', () => {
    history.replaceState(null, '', `/#${b64url(SECRET)}`);
    takeSecretFromAddress();
    savePlace('r-1', 0.4);
    localStorage.setItem('someone.else', 'stays');
    forgetLocal();
    expect(loadSecret()).toBeNull();
    expect(loadPlaces()).toEqual({});
    expect(localStorage.getItem('someone.else')).toBe('stays');
  });
});

describe('places', () => {
  it('keeps a fraction per item and drops those of items that are gone', () => {
    savePlace('r-1', 0.4);
    savePlace('r-2', 7);
    expect(loadPlaces()).toEqual({ 'r-1': 0.4, 'r-2': 1 });
    prunePlaces(new Set(['r-2']));
    expect(loadPlaces()).toEqual({ 'r-2': 1 });
  });

  it('reads nothing from a value that is not a map of fractions', () => {
    localStorage.setItem('shellie.reader.places', '["a"]');
    expect(loadPlaces()).toEqual({});
    localStorage.setItem('shellie.reader.places', '{"r-1":"far","r-2":0.5}');
    expect(loadPlaces()).toEqual({ 'r-2': 0.5 });
  });
});
