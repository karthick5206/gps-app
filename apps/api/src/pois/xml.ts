import { SaxesParser } from 'saxes';

/** Minimal element tree for KML / GPX. Names are local (namespace prefix dropped) and lower-cased. */
export interface XmlNode {
  name: string;
  attrs: Record<string, string>;
  children: XmlNode[];
  text: string;
}

const MAX_DEPTH = 64;
const MAX_NODES = 500_000;

/**
 * Parse an XML document safely: DOCTYPE declarations (and with them every entity definition, internal or external)
 * are rejected outright, so nothing is ever expanded or fetched; only the five predefined XML entities and numeric
 * character references are understood (saxes reports any other entity as an error).
 */
export function parseXml(text: string): XmlNode {
  const parser = new SaxesParser({ xmlns: false, position: false });
  const root: XmlNode = { name: '#document', attrs: {}, children: [], text: '' };
  const stack: XmlNode[] = [root];
  let nodes = 0;
  let failure: Error | null = null;
  const fail = (message: string) => {
    if (!failure) failure = new Error(message);
  };

  parser.on('doctype', () => fail('DOCTYPE / entity declarations are not allowed'));
  parser.on('error', (e) => fail(`Invalid XML: ${e.message.split('\n')[0]}`));
  parser.on('opentag', (tag) => {
    if (failure) return;
    if (stack.length > MAX_DEPTH) return fail('XML is nested too deeply');
    if (++nodes > MAX_NODES) return fail('XML has too many elements');
    const attrs: Record<string, string> = {};
    for (const [k, v] of Object.entries(tag.attributes)) attrs[localName(k)] = String(v);
    const node: XmlNode = { name: localName(tag.name), attrs, children: [], text: '' };
    stack[stack.length - 1].children.push(node);
    if (!tag.isSelfClosing) stack.push(node);
  });
  parser.on('closetag', (tag) => {
    if (failure || tag.isSelfClosing) return;
    stack.pop();
  });
  const onText = (t: string) => {
    if (failure) return;
    const top = stack[stack.length - 1];
    if (top.text.length < 100_000) top.text += t;
  };
  parser.on('text', onText);
  parser.on('cdata', onText);

  // A DOCTYPE can't be reported mid-stream by every parser state: check up front as well.
  if (/<!DOCTYPE|<!ENTITY/i.test(text)) throw new Error('DOCTYPE / entity declarations are not allowed');
  try {
    parser.write(text).close();
  } catch (e) {
    fail(`Invalid XML: ${(e as Error).message.split('\n')[0]}`);
  }
  if (failure) throw failure;
  return root;
}

function localName(name: string): string {
  const i = name.indexOf(':');
  return (i >= 0 ? name.slice(i + 1) : name).toLowerCase();
}

/** Direct children with this (local, lower-case) name. */
export const childrenOf = (n: XmlNode, name: string): XmlNode[] => n.children.filter((c) => c.name === name);
export const childOf = (n: XmlNode, name: string): XmlNode | undefined => n.children.find((c) => c.name === name);
export const childText = (n: XmlNode, name: string): string | undefined => {
  const c = childOf(n, name);
  const t = c?.text.trim();
  return t ? t : undefined;
};

/** Every descendant (depth-first, document order) with this name; does not descend into matches. */
export function findAll(n: XmlNode, name: string, out: XmlNode[] = []): XmlNode[] {
  for (const c of n.children) {
    if (c.name === name) out.push(c);
    else findAll(c, name, out);
  }
  return out;
}

export function findFirst(n: XmlNode, name: string): XmlNode | undefined {
  for (const c of n.children) {
    if (c.name === name) return c;
    const d = findFirst(c, name);
    if (d) return d;
  }
  return undefined;
}

export function escapeXml(s: string): string {
  return s.replace(/[<>&"']/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;', "'": '&apos;' })[c]!);
}
