const stringSimilarity = require('string-similarity');
const fs = require('fs').promises;
const path = require('path');

class DomainAI {
    constructor(options = {}) {
        this.similarityThreshold = options.similarityThreshold || 0.85;
        this.knownPatterns = new Set();
        this.patternWeights = new Map();
        this.learningRate = options.learningRate || 0.1;
        this.patternsFile = path.join(__dirname, 'blocklist', 'ai-patterns.json');
        this.initializePatterns();
    }

    async initializePatterns() {
        try {
            const data = await fs.readFile(this.patternsFile, 'utf8');
            const patterns = JSON.parse(data);
            this.knownPatterns = new Set(patterns.knownPatterns);
            this.patternWeights = new Map(Object.entries(patterns.patternWeights));
        } catch (error) {
            // Initialize with default patterns if file doesn't exist
            this.initializeDefaultPatterns();
        }
    }

    initializeDefaultPatterns() {
        // Common patterns in adult domains
        const defaultPatterns = [
            'porn', 'sex', 'adult', 'xxx', 'nsfw', 'tube',
            'cam', 'live', 'stream', 'chat', 'dating', 'hookup',
            'escort', 'massage', 'nude', 'naked', 'explicit'
        ];
        
        defaultPatterns.forEach(pattern => {
            this.knownPatterns.add(pattern);
            this.patternWeights.set(pattern, 1.0);
        });
    }

    async savePatterns() {
        const patterns = {
            knownPatterns: Array.from(this.knownPatterns),
            patternWeights: Object.fromEntries(this.patternWeights)
        };
        await fs.writeFile(this.patternsFile, JSON.stringify(patterns, null, 2));
    }

    async analyzeDomain(domain, knownBlockedDomains) {
        if (!domain) return false;
        
        domain = domain.toLowerCase().replace(/^www\./, '');
        
        // 1. Direct match check
        if (knownBlockedDomains.has(domain)) {
            return { blocked: true, reason: 'direct_match' };
        }

        // 2. Pattern analysis
        const patternMatch = this.analyzePatterns(domain);
        if (patternMatch.blocked) {
            return patternMatch;
        }

        // 3. Similarity analysis
        const similarityMatch = this.analyzeSimilarity(domain, knownBlockedDomains);
        if (similarityMatch.blocked) {
            return similarityMatch;
        }

        return { blocked: false };
    }

    analyzePatterns(domain) {
        const domainParts = domain.split('.');
        const domainWords = domain.split(/[^a-z0-9]+/);
        
        let totalWeight = 0;
        let matchedPatterns = [];

        // Check each part of the domain
        for (const part of domainParts) {
            for (const pattern of this.knownPatterns) {
                if (part.includes(pattern)) {
                    const weight = this.patternWeights.get(pattern) || 1.0;
                    totalWeight += weight;
                    matchedPatterns.push(pattern);
                }
            }
        }

        // Check domain words
        for (const word of domainWords) {
            for (const pattern of this.knownPatterns) {
                if (word.includes(pattern)) {
                    const weight = this.patternWeights.get(pattern) || 1.0;
                    totalWeight += weight;
                    matchedPatterns.push(pattern);
                }
            }
        }

        // Calculate pattern score
        const patternScore = totalWeight / (domainParts.length + domainWords.length);
        
        if (patternScore > 0.5) {
            return {
                blocked: true,
                reason: 'pattern_match',
                score: patternScore,
                patterns: matchedPatterns
            };
        }

        return { blocked: false };
    }

    analyzeSimilarity(domain, knownBlockedDomains) {
        const similarities = Array.from(knownBlockedDomains).map(knownDomain => ({
            domain: knownDomain,
            similarity: stringSimilarity.compareTwoStrings(domain, knownDomain)
        }));

        const highSimilarity = similarities.find(s => s.similarity > this.similarityThreshold);
        
        if (highSimilarity) {
            return {
                blocked: true,
                reason: 'similarity_match',
                similarity: highSimilarity.similarity,
                similarTo: highSimilarity.domain
            };
        }

        return { blocked: false };
    }

    async learnFromDecision(domain, wasBlocked, correctDecision) {
        if (correctDecision) {
            // If the decision was correct, strengthen the patterns
            const domainParts = domain.split(/[^a-z0-9]+/);
            for (const part of domainParts) {
                for (const pattern of this.knownPatterns) {
                    if (part.includes(pattern)) {
                        const currentWeight = this.patternWeights.get(pattern) || 1.0;
                        this.patternWeights.set(pattern, currentWeight + this.learningRate);
                    }
                }
            }
        } else {
            // If the decision was wrong, weaken the patterns
            const domainParts = domain.split(/[^a-z0-9]+/);
            for (const part of domainParts) {
                for (const pattern of this.knownPatterns) {
                    if (part.includes(pattern)) {
                        const currentWeight = this.patternWeights.get(pattern) || 1.0;
                        this.patternWeights.set(pattern, Math.max(0.1, currentWeight - this.learningRate));
                    }
                }
            }
        }

        await this.savePatterns();
    }

    getStats() {
        return {
            patternCount: this.knownPatterns.size,
            patternWeights: Object.fromEntries(this.patternWeights),
            similarityThreshold: this.similarityThreshold
        };
    }
}

module.exports = DomainAI; 