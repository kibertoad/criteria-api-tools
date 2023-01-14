import { unescapeReferenceToken } from '@criteria/json-pointer'
import { evaluateFragment } from './evaluateFragment'
import { JSONSchema, Reference } from '../JSONSchema'
import { memoize } from '../retrievers/memoize'
import { hasFragment, normalizeURI, resolveURIReference, splitFragment, URI } from '../uri'
import { cloneValues, ContextWithCloneInto } from './visitors/cloneValues'
import { Context } from './visitors/context'
import { indexSchemasInto } from './indexSchemasInto'
import { isPlaceholder, Placeholder, placeholderSymbol } from './placeholder'

interface Options {
  baseURI?: URI
  retrieve?: (uri: URI) => JSONSchema
}

const defaultBaseURI = ''
const defaultRetrieve = (uri: URI): JSONSchema => {
  throw new Error(`Cannot retrieve URI '${uri}'`)
}

export function dereferenceJSONSchema(schema: JSONSchema, options?: Options) {
  // TODO: warn on violations of SHOULD directives

  const baseURI = normalizeURI(options?.baseURI ?? defaultBaseURI)
  const retrieve = memoize((uri: string) => {
    const document = uri === baseURI ? schema : options?.retrieve(uri) ?? defaultRetrieve(uri)
    if (!document) {
      throw new Error(`Invalid document retrieve at uri '${uri}'`)
    }
    return document
  })

  const sourceSchemasByURI: { [uri: URI]: { value: JSONSchema; context: Context } } = {}
  indexSchemasInto(sourceSchemasByURI, schema, baseURI, retrieve)

  // Cache of previously dereferenced values by uri
  // Multiple URIs may refer to the same value
  const dereferencedByURI: { [uri: URI]: any } = {}

  // Maintains reference equality from the source schema
  // Important when the passed in schema is already dereferenced instead of JSON
  const dereferencedBySource = new Map()

  // Objects inserted into the dereferenced object graph
  // prior to being dereferenced to maintain reference equality
  const placeholders = new Set<Placeholder>()

  const dereferenceSubschema = (schema: JSONSchema, context: ContextWithCloneInto<'schema'>) => {
    if (dereferencedBySource.has(schema)) {
      return dereferencedBySource.get(schema)
    }

    let result
    for (const uri of context.resolvedURIs) {
      result = dereferencedByURI[uri]
      if (result) {
        if (!isPlaceholder(result)) {
          return result
        }

        // no longer a placeholder but still need to dereference children
        delete result[placeholderSymbol]
        placeholders.delete(result)
        break
      }
    }

    result = result ?? {} // create new object if no placeholder found
    dereferencedBySource.set(schema, result)
    context.resolvedURIs.forEach((uri) => (dereferencedByURI[uri] = result))
    context.cloneInto(result)
    return result
  }

  const dereferenceReference = (reference: Reference, context: Context) => {
    // Keep following references until we find a concrete value
    // It was important to index all known schemas first so that we can follow all references to their conclusion
    const resolvedURIs = context.resolvedURIs
    let target: typeof sourceSchemasByURI[URI] = { value: reference, context }
    let uri
    while (
      '$ref' in target.value &&
      typeof target.value.$ref === 'string' &&
      Object.keys(target.value).length === 1 // don't follow $ref with siblings since they get dereferenced as unique objects
    ) {
      uri = resolveURIReference(target.value.$ref, target.context.baseURI)
      target = sourceSchemasByURI[uri]
      if (target) {
        resolvedURIs.push(...target.context.resolvedURIs)
      }
      if (!target) {
        const { absoluteURI, fragment } = splitFragment(uri)
        const parentSchema = sourceSchemasByURI[absoluteURI]
        if (parentSchema) {
          const evaluatedValue = evaluateFragment(fragment, parentSchema)
          if (evaluatedValue) {
            target = {
              value: evaluatedValue,
              context: {
                baseURI: absoluteURI,
                jsonPointer: null,
                resolvedURIs: null
              }
            }
          }
        }
        break
      }
    }

    let result = dereferencedByURI[uri]

    // It may be the child of an already dereferenced schema
    if (!result) {
      const { absoluteURI, fragment } = splitFragment(uri)
      const parentSchema = dereferencedByURI[absoluteURI]
      if (parentSchema) {
        result = evaluateFragment(fragment, parentSchema)
      }
    }

    // We haven't dereferenced the target yet, store a placeholder
    if (!result) {
      result = {
        [placeholderSymbol]: { uris: [uri, ...resolvedURIs] }
      }
      placeholders.add(result as Placeholder)
    }

    // If we end up setting a primitive property of this schema,
    // we need to key the dereferenced schema by every uri that points to it
    resolvedURIs.forEach((uri) => (dereferencedByURI[uri] = result))
    return result
  }

  const dereferenceReferenceWithSiblings = (reference: Reference, context: Context) => {
    // Merging $ref and siblings creates a new unique object,
    // otherwise sibling properties will be applied everywhere the same $ref is used
    // Assume that siblings does not need to be further dereferenced

    let result
    for (const uri of context.resolvedURIs) {
      result = dereferencedByURI[uri]
      if (result) {
        if (!isPlaceholder(result)) {
          return result
        }
        break
      }
    }
    result = result ?? {}

    const { $ref, ...siblings } = reference
    const dereferenced = dereferenceReference(
      { $ref },
      {
        baseURI: context.baseURI,
        jsonPointer: context.jsonPointer,
        resolvedURIs: [] // do not pass through since these point to a new unique merge object, not the referenced object
      }
    )

    if (isPlaceholder(dereferenced)) {
      result[placeholderSymbol] = { ...result[placeholderSymbol], indirect: dereferenced }
      result = Object.assign(result, siblings)
      placeholders.add(result as Placeholder)
    } else {
      result = Object.assign(result, dereferenced, siblings)
    }

    context.resolvedURIs.forEach((uri) => (dereferencedByURI[uri] = result))
    return result
  }

  // Actually clone the schema
  const allResults = {}
  for (const [uri, sourceSchema] of Object.entries(sourceSchemasByURI)) {
    if (hasFragment(uri) || sourceSchema.context.jsonPointer !== '') {
      continue
    }
    allResults[uri] = cloneValues(
      sourceSchema.value,
      { baseURI: sourceSchema.context.baseURI, jsonPointer: '', resolvedURIs: [] },
      (value, kind, context) => {
        if (kind === 'schema') {
          return dereferenceSubschema(value, context as ContextWithCloneInto<'schema'>)
        } else if (kind === 'reference') {
          if (Object.keys(value).length == 1) {
            return dereferenceReference(value, context)
          } else {
            return dereferenceReferenceWithSiblings(value, context)
          }
        } else {
          return value
        }
      }
    )
  }

  // Fix up any remaining placeholder objects
  while (placeholders.size > 0) {
    const placeholder = placeholders.values().next().value
    const { uris, indirect } = placeholder[placeholderSymbol]

    if (indirect && isPlaceholder(indirect)) {
      continue // TODO: guard for circular references here?
    }

    if (indirect) {
      // sibling properties that were already dereferenced take precedence
      const { ...siblings } = placeholder
      Object.assign(placeholder, indirect, siblings)

      if (!uris) {
        delete placeholder[placeholderSymbol]
        placeholders.delete(placeholder)
        continue
      }
    }

    delete placeholder[placeholderSymbol]
    placeholders.delete(placeholder)

    const uri = uris[0]
    let realValue = dereferencedByURI[uri]
    if (!realValue) {
      const { absoluteURI, fragment } = splitFragment(uri)
      let parentSchema = dereferencedByURI[absoluteURI]
      if (parentSchema) {
        realValue = evaluateFragment(fragment, parentSchema)
      }
      if (!realValue) {
        throw new Error(`No placeholder at ${uri}`)
      }
    }

    if (typeof realValue === 'object') {
      // sibling properties that were already dereferenced take precedence
      const siblings = { ...placeholder }
      Object.assign(placeholder, realValue, siblings)
    } else {
      Object.assign(placeholder, { uris })

      // The placeholder was for a primitive value
      uris.forEach((uri) => {
        const index = uri.lastIndexOf('/')
        const parentURI = uri.slice(0, index)
        const lastKey = unescapeReferenceToken(uri.slice(index + 1))

        const parent = dereferencedByURI[parentURI]
        if (parent) {
          parent[lastKey] = realValue
        } else {
          throw new Error(`Could not dereference value at ${uri}, parent does not exist.`)
        }
      })
    }
  }

  return allResults[baseURI]
}
