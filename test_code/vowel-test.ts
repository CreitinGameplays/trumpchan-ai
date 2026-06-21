// vowel-test.ts
// Automated test script to test A, E, I, O, U mouth movements

async function setExpression(expression: string, value: number) {
    console.log(`Setting expression ${expression} to ${value}`);
    try {
        await fetch('http://localhost:3000/api/command', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({
                type: 'expression',
                expression: expression,
                value: value
            })
        });
    } catch (err) {
        console.error('Failed to send expression:', err);
    }
}

async function delay(ms: number) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

async function runTest() {
    console.log('Starting VRoid Vowel Expression Test...');

    // Expressions in VRM format are generally 'aa', 'ee', 'ih', 'oh', 'ou'
    const vowels = [
        { label: 'A', name: 'aa' },
        { label: 'E', name: 'ee' },
        { label: 'I', name: 'ih' },
        { label: 'O', name: 'oh' },
        { label: 'U', name: 'ou' }
    ];

    for (const vowel of vowels) {
        console.log(`\n=== Testing Vowel: ${vowel.label} (${vowel.name}) ===`);

        // Set to 1.0 (fully active)
        await setExpression(vowel.name, 1.0);
        await delay(1500); // Hold for 1.5s

        // Reset to 0.0
        await setExpression(vowel.name, 0.0);
        await delay(500); // Small pause before next
    }

    // Let's also test look at as an example
    console.log('\n=== Testing LookAt API ===');
    await fetch('http://localhost:3000/api/command', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ type: 'lookAt', target: { x: 2, y: 1.5, z: 2 } })
    });
    await delay(1500);
    await fetch('http://localhost:3000/api/command', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ type: 'lookAt', target: { x: -2, y: 1.5, z: 2 } })
    });
    await delay(1500);

    console.log('\nTest completed successfully!');
}

runTest();
