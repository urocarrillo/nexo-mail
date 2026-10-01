import { parseManychatId, sourceConDm, TAGS_PUENTE, TAGS_TIER } from '@/lib/manychat';

describe('manychat: helpers puros', () => {
  it('parseManychatId acepta enteros positivos como string o number', () => {
    expect(parseManychatId('1234567890123')).toBe('1234567890123');
    expect(parseManychatId(' 42 ')).toBe('42');
    expect(parseManychatId(42)).toBe('42');
  });

  it('parseManychatId rechaza vacío, texto, ceros a la izquierda y basura', () => {
    expect(parseManychatId('')).toBeNull();
    expect(parseManychatId('{Id de contacto}')).toBeNull();
    expect(parseManychatId('0123')).toBeNull();
    expect(parseManychatId('12a')).toBeNull();
    expect(parseManychatId(undefined)).toBeNull();
    expect(parseManychatId(null)).toBeNull();
    expect(parseManychatId(-5)).toBeNull();
    expect(parseManychatId('1'.repeat(21))).toBeNull();
  });

  it('sourceConDm pasa instagram/tiktok a -dm solo con id', () => {
    expect(sourceConDm('tiktok', '123')).toBe('tiktok-dm');
    expect(sourceConDm('instagram', '123')).toBe('instagram-dm');
    expect(sourceConDm('tiktok', null)).toBe('tiktok');
    expect(sourceConDm('web', '123')).toBe('web');
    expect(sourceConDm('tiktok-dm', '123')).toBe('tiktok-dm');
  });

  it('las etiquetas del puente son las del plan', () => {
    expect(TAGS_TIER).toEqual({ A: 'TIER A', B: 'TIER B', C: 'TIER C' });
    expect(TAGS_PUENTE).toEqual(['TIER A', 'TIER B', 'TIER C', 'CLIENTE']);
  });
});
