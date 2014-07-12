# whale

whale makes docker easier to use

```
npm install -g whale
```

## Usage

```
$ whale help
```

You can also use whale as a node module with similar functionality as the command line tool

```
var whale = require('whale')
var w = whale('localhost:2375') // insert the address to docker here

var log = w.log('some-container')

log.stdout.pipe(process.stdout)
log.stderr.pipe(process.stderr)
```

More docs to come. For now see the source for more.

## License

MIT