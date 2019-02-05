const Transform = require('stream').Transform
const File = require('vinyl')
const PluginError = require('plugin-error')
const rollup = require('rollup')
const path = require('path')
const applySourceMap = require('vinyl-sourcemaps-apply')
const camelCase = require('lodash.camelcase')

const PLUGIN_NAME = 'gulp-better-rollup'

// map object storing rollup cache objects for each input file
const rollupCache = new Map()

function parseBundles (arg) {
  if (typeof arg === 'string') {
    return [
      {
        format: arg
      }
    ]
  }
  if (arg instanceof Array) return arg
  return [arg]
}

function assignCertainProperties (toObject, fromObject, properties = []) {
  for (const key of properties) {
    if (toObject[key] === undefined && fromObject[key] !== undefined) {
      toObject[key] = fromObject[key]
    }
  }
}

// transformer class
class GulpRollup extends Transform {
  _transform (file, encoding, cb) {
    // cannot handle empty or unavailable files
    if (file.isNull()) return cb(null, file)

    // cannot handle streams
    if (file.isStream()) {
      return cb(new PluginError(PLUGIN_NAME, 'Streaming not supported'))
    }

    let inputOptions = {}
    let bundleList

    if (this.arg2) {
      inputOptions = Object.assign({}, this.arg1)
      bundleList = parseBundles(this.arg2)
    } else {
      bundleList = parseBundles(this.arg1)
    }

    // user should not specify the input file path, but let him if he insists for some reason
    if (inputOptions.input === undefined) {
      // determine input from file filename
      inputOptions.input = path.relative(file.cwd, file.path)
    } else file.path = path.join(file.cwd, inputOptions.input)

    // caching is enabled by default because of the nature of gulp and the watching/recompilatin
    // but can be disabled by setting 'cache' to false
    if (inputOptions.cache !== false) {
      inputOptions.cache = rollupCache.get(inputOptions.input)
    }

    // enable sourcemap is gulp-sourcemaps plugin is enabled
    const createSourceMap = file.sourceMap !== undefined

    const originalCwd = file.cwd
    const originalPath = file.path
    const moduleName = camelCase(
      path.basename(file.path, path.extname(file.path))
    )

    const propsToCopy = [
      'format',
      'file',
      'dir',
      'globals',
      'paths',
      'banner',
      'footer',
      'intro',
      'outro',
      'sourcemap',
      'sourcemapFile',
      'interop',
      'extend',
      'exports',
      'indent',
      'strict',
      'freeze',
      'legacy',
      'namespaceToStringTag'
    ]

    function isNewOutputFormat (result) {
      return (
        result != null &&
        result.output != null &&
        result.output[0] != null &&
        result.output[0].code != null
      )
    }

    /**
     * Newer versions of rollup output a different bundle object. This will retrieve code from either
     * @param {BundleResult} result the output from rollup
     * @return {string} code
     */
    function getOutputCode (result) {
      return isNewOutputFormat(result) ? result.output[0].code : result.code
    }

    function generateAndApplyBundle (bundle, outputOptions, targetFile) {
      assignCertainProperties(outputOptions, inputOptions, propsToCopy)
      // Rollup won't bundle iife and umd modules without module name.
      // But it won't say anything either, leaving a space for confusion
      if (outputOptions.name === undefined) {
        outputOptions.name = inputOptions.name || moduleName
      }
      if (
        outputOptions.amd === undefined ||
        outputOptions.amd.id === undefined
      ) {
        outputOptions.amd = Object.assign({}, outputOptions.amd, {
          id: outputOptions.name
        })
      }
      outputOptions.sourcemap = createSourceMap
      // generate bundle according to given or autocompleted options
      return bundle.generate(outputOptions).then(result => {
        if (result === undefined) return
        // Pass sourcemap content and metadata to gulp-sourcemaps plugin to handle
        // destination (and custom name) was given, possibly multiple output bundles.
        if (createSourceMap) {
          result.map.file = path.relative(originalCwd, originalPath)
          result.map.sources = result.map.sources.map(source =>
            path.relative(originalCwd, source)
          )
        }

        // if the output is the newer format,
        // build the buffer that way
        targetFile.contents = Buffer.from(getOutputCode(result))
        // apply sourcemap to output file
        if (createSourceMap) applySourceMap(targetFile, result.map)
      })
    }
    const createBundle = (bundle, outputOptions, injectNewFile) => {
      // custom output name might be set
      if (outputOptions.file) {
        // setup filename name from outputOptions.file
        const newFileName = path.basename(outputOptions.file)
        const newFilePath = path.join(file.base, newFileName)
        if (injectNewFile) {
          // create new file and inject it into stream if needed (in case of multiple outputs)
          const newFile = new File({
            cwd: file.cwd,
            base: file.base,
            path: newFilePath,
            stat: {
              isFile: () => true,
              isDirectory: () => false,
              isBlockDevice: () => false,
              isCharacterDevice: () => false,
              isSymbolicLink: () => false,
              isFIFO: () => false,
              isSocket: () => false
            }
          })
          return generateAndApplyBundle(bundle, outputOptions, newFile).then(
            result => {
              this.push(newFile)
              return result
            }
          )
        } else {
          // rename original file
          file.path = newFilePath
          return generateAndApplyBundle(bundle, outputOptions, file)
        }
      } else {
        // file wasnt renamed nor new one was created,
        // apply data and sourcemaps to the original file
        return generateAndApplyBundle(bundle, outputOptions, file)
      }
    }

    // custom rollup can be provided inside the config object
    const localRollup = inputOptions.rollup || rollup
    delete inputOptions.rollup
    localRollup
      // pass basic options to rollup
      .rollup(inputOptions)
      // after the magic is done, configure the output format
      .then(bundle => {
        // cache rollup object if caching is enabled
        if (inputOptions.cache !== false) {
          rollupCache.set(inputOptions.input, bundle)
        }
        // generate ouput according to (each of) given outputOptions
        return Promise.all(
          bundleList.map((outputOptions, i) =>
            createBundle(bundle, outputOptions, i)
          )
        )
      })
      // pass file to gulp and end stream
      .then(() => cb(null, file))
      .catch(err => {
        if (inputOptions.cache !== false) rollupCache.delete(inputOptions.input)
        process.nextTick(() => {
          this.emit('error', new PluginError(PLUGIN_NAME, err))
          cb(null, file)
        })
      })
  }
}

// first argument (inputOptions) is optional
module.exports = function factory (arg1, arg2) {
  // instantiate the stream class
  const stream = new GulpRollup({
    objectMode: true
  })
  // pass in options objects
  stream.arg1 = arg1
  stream.arg2 = arg2
  // return the stream instance
  return stream
}
