import * as blessed from 'blessed'
import * as cheerio from 'cheerio'
import * as fs from 'fs'
import * as http from 'http'
import * as https from 'https'

type Selector = string

enum ElementPredicates {
    ContentMatches = 'content_matches',
    Not = 'not'
}

interface ContentMatches {
    kind: ElementPredicates.ContentMatches
    content: string
}

interface Not {
    kind: ElementPredicates.Not,
    subPredicate: ElementPredicate
}

type ElementPredicate = ContentMatches | Not

enum SitePredicates {
    ElementMatches = 'element_matches'
}

interface ElementMatches {
    kind: SitePredicates.ElementMatches,
    selector: Selector,
    elementPredicate: ElementPredicate
}

type SitePredicate = ElementMatches

interface SiteSpec {
    url: string,
    sitePredicate: SitePredicate
}

function stripSingleQuotes(input: string): string {
    const match = input.match(/^'(.+)'$/)
    if (match) {
        return match[1]
    } else {
        return input
    }
}

function parseElementPredicate(elementPredicateString: string): ElementPredicate {
    const [predicateName, predicateParameters] = parseFunctionCall(elementPredicateString)
    if (predicateName == 'content_matches') {
        if (predicateParameters.length == 1) {
            return {
                kind: ElementPredicates.ContentMatches,
                content: stripSingleQuotes(predicateParameters[0])
            }
        }
    } else if (predicateName == 'not') {
        if (predicateParameters.length == 1) {
            return {
                kind: ElementPredicates.Not,
                subPredicate: parseElementPredicate(predicateParameters[0])
            }
        }
    }
    throw new Error('Could not parse element predicate from: ' + elementPredicateString)
}

function parseFunctionCall(input: string): [string, string[]] {
    const match = input.match(/^(\w+)\((.+)\)$/)
    if (match) {
        const functionName = match[1]
        const parameters = match[2].split(",").map(p => p.trim())
        return [functionName, parameters]
    }
    throw new Error('Could not parse function call from: ' + input)
}

function parseSitePredicate(predicateString: string): SitePredicate {
    const [predicateName, predicateParameters] = parseFunctionCall(predicateString)
    if (predicateName == 'element_matches') {
        if (predicateParameters.length == 2) {
            const selector = stripSingleQuotes(predicateParameters[0])
            const elementPredicate = parseElementPredicate(predicateParameters[1])
            return {
                kind: SitePredicates.ElementMatches,
                selector,
                elementPredicate: elementPredicate
            }
        }
    }
    throw new Error('Could not parse site predicate from: ' + predicateString)
}

function parseSiteSpec(line: string): SiteSpec {
    const parts = line.split('|')
    if (parts.length == 2) {
        const url = parts[0]
        const predicate = parseSitePredicate(parts[1])
        return {
            url,
            sitePredicate: predicate
        }
    }
    throw new Error('Could not parse site spec from: ' + line)
}

function getContent(url: string): PromiseLike<string> {
  // return new pending promise
  return new Promise((resolve, reject) => {
    const responseHandler = (response: http.IncomingMessage | https.IncomingMessage) => {
      // handle http errors
      response.statusCode
      if (response.statusCode && (response.statusCode < 200 || response.statusCode > 299)) {
         reject(new Error('Failed to load page, status code: ' + response.statusCode));
       }
      // temporary data holder
      const body: string[] = [];
      // on every content chunk, push it to the data array
      response.on('data', (chunk: string) => body.push(chunk));
      // we are done, resolve promise with those joined chunks
      response.on('end', () => resolve(body.join('')));
    }
    // select http or https module, depending on reqested url
    let request
    if (url.startsWith('https')) {
        request = https.get(url, responseHandler)
    } else {
        request = http.get(url, responseHandler)
    }
    request.on('error', (err: any) => reject(err))
    })
};

function elementPredicateMatches(element: Cheerio, elementPredicate: ElementPredicate): boolean {
    switch(elementPredicate.kind) {
        case ElementPredicates.Not: return !elementPredicateMatches(element, elementPredicate.subPredicate)
        case ElementPredicates.ContentMatches:
            return element.text() == elementPredicate.content
    }
}

function elementMatches(domTree: CheerioStatic, selector: string, elementPredicate: ElementPredicate) {
    const foundElement = domTree(selector)
    if (foundElement) {
        return (elementPredicateMatches(foundElement, elementPredicate))
    }
    console.error('Could not find element', selector)
    return false
}

function sitePredicateMatches(sitePredicate: SitePredicate, domTree: CheerioStatic): boolean {
    switch (sitePredicate.kind) {
        case SitePredicates.ElementMatches: return elementMatches(domTree, sitePredicate.selector, sitePredicate.elementPredicate)
    }
}

function checkSiteSpec(siteSpec: SiteSpec): void {
    getContent(siteSpec.url)
        .then(content => {
            const domTree = cheerio.load(content)
            if (sitePredicateMatches(siteSpec.sitePredicate, domTree)) {
                console.log('Predicate', siteSpec.sitePredicate, 'matched for URL', siteSpec.url)
            } else {
                console.log('Predicate', siteSpec.sitePredicate, 'did not match for URL', siteSpec.url)
            }
        })
}

const specFile = process.env.SPECFILE
if (specFile) {
    const siteSpecs: SiteSpec[] = fs.readFileSync(specFile, 'utf-8').split("\n").map(line => {
        return parseSiteSpec(line)
    })
    siteSpecs.forEach(checkSiteSpec)
} else {
    throw new Error('SPECFILE environment variable is not defined')
}