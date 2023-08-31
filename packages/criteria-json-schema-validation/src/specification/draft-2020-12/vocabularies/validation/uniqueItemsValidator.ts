import { DereferencedJSONSchemaObjectDraft2020_12 } from '@criteria/json-schema'
import { JSONPointer } from '../../../../util/JSONPointer'
import circularEqual from '../../../../util/circularEqual'
import { formatList } from '../../../../util/formatList'
import { isJSONArray } from '../../../../util/isJSONArray'
import { assert } from '../../../../validation/assert'
import { ValidatorContext } from '../../../../validation/jsonValidator'
import { Output } from '../../../../validation/Output'

export function uniqueItemsValidator(
  schema: DereferencedJSONSchemaObjectDraft2020_12,
  schemaLocation: JSONPointer,
  context: ValidatorContext
) {
  if (!('uniqueItems' in schema)) {
    return null
  }

  const uniqueItems = schema['uniqueItems']
  if (!uniqueItems) {
    return null
  }

  const failFast = context.failFast
  return (instance: any, instanceLocation: JSONPointer, annotationResults: Record<string, any>): Output => {
    if (!isJSONArray(instance)) {
      return { valid: true, schemaLocation, instanceLocation }
    }

    const matchingPairs: [number, number][] = []
    for (let i = 0; i < instance.length; i++) {
      for (let j = i + 1; j < instance.length; j++) {
        const equal = circularEqual(instance[i], instance[j])
        if (equal) {
          if (failFast) {
            return {
              valid: false,
              schemaLocation,
              schemaKeyword: 'uniqueItems',
              instanceLocation,
              message: `should have unique items but items at ${i} and ${j} are equal instead`
            }
          }
          matchingPairs.push([i, j])
        }
      }
    }

    return assert(
      matchingPairs.length === 0,
      `should have unique items but ${formatList(
        matchingPairs.map((pair) => `items at ${pair[0]} and ${pair[1]} are equal`),
        'and'
      )} instead`,
      {
        schemaLocation,
        schemaKeyword: 'uniqueItems',
        instanceLocation
      }
    )
  }
}
