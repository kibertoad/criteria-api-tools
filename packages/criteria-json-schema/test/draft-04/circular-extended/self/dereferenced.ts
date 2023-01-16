export default {
  definitions: {
    thing: {
      title: 'thing',
      description:
        "This JSON Reference has additional properties (other than $ref). Normally, this creates a new type that extends the referenced type, but since this reference points to ITSELF, it doesn't do that.\n"
    }
  }
}
