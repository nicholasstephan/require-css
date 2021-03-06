define(['require', './normalize'], function(req, normalize) {
  var baseUrl = require.toUrl('.');
  
  var cssAPI = {};
  
  function compress(css) {
    if (typeof process !== "undefined" && process.versions && !!process.versions.node && require.nodeRequire) {
      try {
        var csso = require.nodeRequire('csso');
        var csslen = css.length;
        css = csso.justDoIt(css);
        console.log('Compressed CSS output to ' + Math.round(css.length / csslen * 100) + '%.');
        return css;
      }
      catch(e) {
        console.log('Compression module not installed. Use "npm install csso -g" to enable.');
        return css;
      }
    }
    console.log('Compression not supported outside of nodejs environments.');
    return css;
  }
  
  //load file code - stolen from text plugin
  function loadFile(path) {
    if (typeof process !== "undefined" && process.versions && !!process.versions.node && require.nodeRequire) {
      var fs = require.nodeRequire('fs');
      var file = fs.readFileSync(path, 'utf8');
      if (file.indexOf('\uFEFF') === 0)
        return file.substring(1);
      return file;
    }
    else {
      var file = new java.io.File(path),
        lineSeparator = java.lang.System.getProperty("line.separator"),
        input = new java.io.BufferedReader(new java.io.InputStreamReader(new java.io.FileInputStream(file), 'utf-8')),
        stringBuffer, line;
      try {
        stringBuffer = new java.lang.StringBuffer();
        line = input.readLine();
        if (line && line.length() && line.charAt(0) === 0xfeff)
          line = line.substring(1);
        stringBuffer.append(line);
        while ((line = input.readLine()) !== null) {
          stringBuffer.append(lineSeparator).append(line);
        }
        return String(stringBuffer.toString());
      }
      finally {
        input.close();
      }
    }
  }
  
  
  function saveFile(path, data) {
    if (typeof process !== "undefined" && process.versions && !!process.versions.node && require.nodeRequire) {
      var fs = require.nodeRequire('fs');
      fs.writeFileSync(path, data, 'utf8');
    }
    else {
      var content = new java.lang.String(data);
      var output = new java.io.BufferedWriter(new java.io.OutputStreamWriter(new java.io.FileOutputStream(path), 'utf-8'));
  
      try {
        output.write(content, 0, content.length());
        output.flush();
      }
      finally {
        output.close();
      }
    }
  }
  
  //when adding to the link buffer, paths are normalised to the baseUrl
  //when removing from the link buffer, paths are normalised to the output file path
  function escape(content) {
    return content.replace(/(["'\\])/g, '\\$1')
      .replace(/[\f]/g, "\\f")
      .replace(/[\b]/g, "\\b")
      .replace(/[\n]/g, "\\n")
      .replace(/[\t]/g, "\\t")
      .replace(/[\r]/g, "\\r");
  }
  
  var loadCSS = function(cssId, parse) {
    var fileUrl = cssId;
    
    if (fileUrl.substr(fileUrl.length - 4, 4) != '.css' && !parse)
      fileUrl += '.css';
    
    fileUrl = req.toUrl(fileUrl);
    
    //external URLS don't get added (just like JS requires)
    if (fileUrl.substr(0, 7) == 'http://' || fileUrl.substr(0, 8) == 'https://')
      return;
    
    //add to the buffer
    var css = loadFile(fileUrl);
    if (parse)
      css = parse(css);
      
    //normalize all css to the base url - as the common path reference
    //for injection we then only need one normalization from the base url
    css = normalize(css, fileUrl, baseUrl);
    
    return css;
  }
  
  var curModule;
  cssAPI.load = function(name, req, load, config) {
    if (config.modules) {
      //run through the module list - the first one without a layer set is the current layer we are in
      //allows to track the current layer number for layer-specific config
      for (var i = 0; i < config.modules.length; i++)
        if (config.modules[i].layer === undefined) {
          curModule = i;
          break;
        }
    }
    
    //store config
    cssAPI.config = cssAPI.config || config;
    //just return - 'write' calls are made after exclusions so we run loading there
    load();
  }
  
  cssAPI.normalize = function(name, normalize) {
    if (name.substr(name.length - 1, 1) == '!')
      name = name.substr(0, name.length - 1);
    if (name.substr(name.length - 4, 4) == '.css')
      name = name.substr(0, name.length - 4);
    return normalize(name);
  }
  
  //list of cssIds included in this layer
  var _layerBuffer = [];
  
  cssAPI.write = function(pluginName, moduleName, write, extension, parse) {
    //external URLS don't get added (just like JS requires)
    if (moduleName.substr(0, 7) == 'http://' || moduleName.substr(0, 8) == 'https://')
      return;
    
    _layerBuffer.push(loadCSS(moduleName + (extension ? '.' + extension : ''), parse));
    
    write.asModule(pluginName + '!' + moduleName, 'define(function(){})');
  }
  
  cssAPI.onLayerEnd = function(write, data) {
    //separateCSS parameter set either globally or as a layer setting
    var separateCSS = false;
    if (cssAPI.config.separateCSS)
      separateCSS = true;
    if (typeof curModule == 'number' && cssAPI.config.modules[curModule].separateCSS !== undefined)
      separateCSS = cssAPI.config.modules[curModule].separateCSS;
    curModule = null;
    
    //calculate layer css
    var css = _layerBuffer.join('');
    
    if (separateCSS) {
      if (typeof console != 'undefined' && console.log)
        console.log('Writing CSS! file: ' + data.name + '\n');
      
      //calculate the css output path for this layer
      var path = this.config.dir ? this.config.dir + data.name + '.css' : cssAPI.config.out.replace(/\.js$/, '.css');
      
      //renormalize the css to the output path
      var output = compress(normalize(css, baseUrl, path));
      
      saveFile(path, output);
    }
    else {
      if (css == '')
        return;
      //write the injection and layer index into the layer
      //prepare the css
      css = escape(compress(css));
      
      //derive the absolute path for the normalize helper
      var normalizeParts = req.toUrl('css').substr(baseUrl.length - 1).split('/');
      normalizeParts[normalizeParts.length - 1] = 'normalize';
      var normalizeName = normalizeParts.join('/');
      
      //the code below overrides async require functionality to ensure instant layer css injection
      //it then runs normalization and injection
      //normalization is based on determining the absolute pathname of the html page
      //then determining the absolute baseurl url
      //normalization is then performed from the absolute baseurl to the absolute pathname
      write(''
        + 'for (var c in requirejs.s.contexts) { requirejs.s.contexts[c].nextTick = function(f){f()} } \n'
        + 'require([\'css\', \'' + normalizeName + '\', \'require\'], function(css, normalize, require) { \n'
        + 'var pathname = window.location.pathname.split(\'/\'); \n'
        + 'pathname.pop(); \n'
        + 'pathname = pathname.join(\'/\') + \'/\'; \n'
        + 'var baseUrl = require.toUrl(\'.\'); \n'
        + 'baseUrl = normalize.convertURIBase(baseUrl, pathname, \'/\'); \n'
        + 'css.inject(normalize(\'' + css + '\', baseUrl, pathname)); \n'
        + '}); \n'
        + 'for (var c in requirejs.s.contexts) { requirejs.s.contexts[c].nextTick = requirejs.nextTick; } \n'
      );
    }
    
    //clear layer buffer for next layer
    _layerBuffer = [];
  }
  
  return cssAPI;
});
